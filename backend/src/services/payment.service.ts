import crypto from "node:crypto";
import { prisma } from "../config/prisma";
import { env } from "../config/env";
import { Errors } from "../utils/apiError";
import { PLANS, PaidPlan, isPaidPlan } from "../utils/plans";
import * as razorpay from "../integrations/razorpay.provider";
import { verifyPaymentSignature } from "../utils/razorpaySignature";
import * as subscriptionService from "./subscription.service";

export async function startCheckout(userId: string, plan: string) {
  if (!isPaidPlan(plan)) throw Errors.validation(`Unknown plan "${plan}".`);
  const planConfig = PLANS[plan];

  const order = await razorpay.createOrder({
    amount: planConfig.amount,
    currency: planConfig.currency,
    // Razorpay rejects receipts longer than 40 characters (a cuid userId alone is 25). The full userId is in notes.
    receipt: `r_${userId.slice(-12)}_${Date.now()}`,
    notes: { userId, plan },
  });

  const payment = await prisma.payment.create({
    data: {
      userId,
      provider: "razorpay",
      orderId: order.id,
      amount: planConfig.amount,
      currency: planConfig.currency,
      status: "CREATED",
      metadata: { plan },
    },
  });

  return {
    paymentId: payment.id,
    orderId: order.id,
    amount: planConfig.amount,
    currency: planConfig.currency,
    keyId: env.RAZORPAY_KEY_ID,
    plan,
  };
}

// Called by the frontend's Razorpay Checkout success handler with the
// razorpay_order_id / razorpay_payment_id / razorpay_signature triple.
// Trustworthy on its own because the signature is a cryptographic proof
// from Razorpay (see razorpaySignature.ts) — this is not "the frontend
// reported success," it's "Razorpay's own HMAC over these exact ids
// verifies." The webhook below still runs independently as a backstop for
// the case where the user closes the tab before this call completes.
export async function verifyCheckout(
  userId: string,
  params: { orderId: string; paymentId: string; signature: string }
) {
  const payment = await prisma.payment.findFirst({ where: { orderId: params.orderId, userId } });
  if (!payment) throw Errors.notFound("Payment");

  if (payment.status === "PAID") {
    // Already activated (most likely by the webhook arriving first) —
    // idempotent success, not an error, so a retried frontend call is safe.
    return { status: "PAID", alreadyProcessed: true };
  }
  // FAILED is allowed through: Razorpay lets a customer retry the same order after a failed attempt,
  // and the signature check below is the actual proof of payment. REFUNDED stays rejected.
  if (payment.status !== "CREATED" && payment.status !== "FAILED") {
    throw Errors.paymentAlreadyProcessed();
  }

  const valid = verifyPaymentSignature({
    orderId: params.orderId,
    paymentId: params.paymentId,
    signature: params.signature,
    secret: env.RAZORPAY_KEY_SECRET,
  });

  if (!valid) {
    await prisma.payment.update({ where: { id: payment.id }, data: { status: "FAILED" } });
    throw Errors.paymentVerificationFailed();
  }

  // Atomic claim: /verify and the webhook can arrive at the same moment. Only the one that flips the
  // row to PAID may activate the subscription, otherwise the user gets the term twice.
  const claimed = await prisma.payment.updateMany({
    where: { id: payment.id, status: { in: ["CREATED", "FAILED"] } },
    data: { status: "PAID", paymentId: params.paymentId, signature: params.signature },
  });
  if (claimed.count === 0) return { status: "PAID", alreadyProcessed: true };

  try {
    await subscriptionService.activateFromPayment({ ...payment, status: "PAID", paymentId: params.paymentId });
  } catch (err) {
    // Money was taken but the subscription wasn't granted: put the payment back so a retry
    // (or the webhook) can activate it instead of being skipped as "already PAID".
    await prisma.payment.updateMany({ where: { id: payment.id, status: "PAID" }, data: { status: "CREATED" } });
    throw err;
  }

  return { status: "PAID", alreadyProcessed: false };
}

export async function listPaymentHistory(userId: string) {
  return prisma.payment.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      provider: true,
      orderId: true,
      amount: true,
      currency: true,
      status: true,
      metadata: true,
      createdAt: true,
    },
  });
}

interface RazorpayWebhookEvent {
  event: string;
  payload: {
    payment?: { entity: { id: string; order_id: string; status: string } };
    refund?: { entity: { id: string; payment_id: string } };
  };
}

export async function handleWebhookEvent(rawBody: Buffer, event: RazorpayWebhookEvent): Promise<void> {
  // Body-hash idempotency: Razorpay retries webhook delivery on anything but
  // a 2xx, and unlike Stripe there's no single canonical event-id field
  // across all Razorpay event types, so a hash of the exact raw payload is
  // the dedupe key.
  const eventHash = crypto.createHash("sha256").update(rawBody).digest("hex");

  // Record the delivery first (unique key => concurrent duplicates lose the race cleanly) ...
  try {
    await prisma.paymentWebhookEvent.create({ data: { eventHash } });
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") return; // exact redelivery — already handled
    throw err;
  }

  // ... but if processing fails, forget it again. Otherwise Razorpay's retry would be dropped as a
  // "duplicate" and a paid order would never be activated.
  try {
    await processWebhookEvent(event);
  } catch (err) {
    await prisma.paymentWebhookEvent.deleteMany({ where: { eventHash } }).catch(() => undefined);
    throw err;
  }
}

async function processWebhookEvent(event: RazorpayWebhookEvent): Promise<void> {
  if (event.event === "payment.captured" && event.payload.payment) {
    const entity = event.payload.payment.entity;
    const payment = await prisma.payment.findFirst({ where: { orderId: entity.order_id } });
    if (!payment) return; // order this backend never created (different mode/key) — ignore
    if (payment.status === "PAID" || payment.status === "REFUNDED") return; // already handled

    // Same atomic claim as /verify so the two can't both activate.
    const claimed = await prisma.payment.updateMany({
      where: { id: payment.id, status: { in: ["CREATED", "FAILED"] } },
      data: { status: "PAID", paymentId: entity.id },
    });
    if (claimed.count === 0) return;
    try {
      await subscriptionService.activateFromPayment({ ...payment, status: "PAID", paymentId: entity.id });
    } catch (err) {
      await prisma.payment.updateMany({ where: { id: payment.id, status: "PAID" }, data: { status: "CREATED" } });
      throw err;
    }
    return;
  }

  if (event.event === "payment.failed" && event.payload.payment) {
    const entity = event.payload.payment.entity;
    const payment = await prisma.payment.findFirst({ where: { orderId: entity.order_id } });
    if (!payment || payment.status !== "CREATED") return;
    await prisma.payment.updateMany({ where: { id: payment.id, status: "CREATED" }, data: { status: "FAILED" } });
    return;
  }

  if (event.event === "refund.processed" && event.payload.payment) {
    const entity = event.payload.payment.entity;
    const payment = await prisma.payment.findFirst({ where: { orderId: entity.order_id } });
    if (!payment) return;
    const refunded = await prisma.payment.update({ where: { id: payment.id }, data: { status: "REFUNDED" } });
    await subscriptionService.revokeForRefundedPayment(refunded);
    return;
  }

  // Any other event type (order.paid, subscription.* from Razorpay's
  // separate mandate-based product, etc.) is intentionally ignored rather
  // than erroring — same reasoning as the Stripe Identity webhook: a
  // shared endpoint receives event types it was never going to act on, and
  // 4xx-ing those just causes Razorpay to keep retrying them.
}

export { PLANS };
export type { PaidPlan };
