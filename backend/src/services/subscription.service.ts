import { prisma } from "../config/prisma";
import { Errors } from "../utils/apiError";
import { PLANS, PaidPlan } from "../utils/plans";
import { createNotification } from "./notification.service";
import type { Payment } from "@prisma/client";

export interface Entitlement {
  plan: "FREE" | PaidPlan;
  active: boolean;
  status: string | null;
  expiresAt: Date | null;
}

// The backend is the only thing that decides entitlement — the frontend
// only displays this result, never computes it locally (see master prompt
// section 53). ACTIVE and CANCELLED both still grant access up to endDate;
// CANCELLED just means it won't be renewed. This treats "expired" lazily —
// there's no cron flipping status to EXPIRED, GET always re-derives it from
// endDate, so a stale status value can never grant access past its date.
export async function getEntitlement(userId: string): Promise<Entitlement> {
  const subscription = await prisma.subscription.findFirst({
    where: { userId, status: { in: ["ACTIVE", "CANCELLED"] } },
    orderBy: { endDate: "desc" },
  });

  if (!subscription || !subscription.endDate || subscription.endDate <= new Date()) {
    return { plan: "FREE", active: true, status: null, expiresAt: null };
  }

  return {
    plan: subscription.plan as PaidPlan,
    active: true,
    status: subscription.status,
    expiresAt: subscription.endDate,
  };
}

// Called only from payment.service once a payment is confirmed PAID — by a
// verified checkout signature or by the webhook, never by an unverified
// client claim. If the user already has time remaining on the *same* plan,
// the new purchase extends from the later of "now" or the current
// expiration (so buying early never wastes remaining paid days). Switching
// plans starts the new term from now and ends the old one immediately.
export async function activateFromPayment(payment: Payment): Promise<void> {
  const plan = (payment.metadata as { plan?: string } | null)?.plan;
  if (!plan || !(plan in PLANS)) {
    throw new Error(`Payment ${payment.id} has no valid plan in metadata; cannot activate a subscription.`);
  }
  const planKey = plan as PaidPlan;
  const planConfig = PLANS[planKey];

  await prisma.$transaction(async (tx) => {
    const current = await tx.subscription.findFirst({
      where: { userId: payment.userId, status: { in: ["ACTIVE", "CANCELLED"] } },
      orderBy: { endDate: "desc" },
    });

    const stillActive = current?.endDate && current.endDate > new Date();
    const samePlan = stillActive && current?.plan === planKey;

    if (current && stillActive && !samePlan) {
      // Switching plans mid-term: end the old one now rather than letting
      // two "active" rows coexist with ambiguous precedence.
      await tx.subscription.update({ where: { id: current.id }, data: { status: "ENDED", endDate: new Date() } });
    }

    const base = samePlan && current?.endDate ? current.endDate : new Date();
    const endDate = new Date(base.getTime() + planConfig.durationDays * 24 * 60 * 60 * 1000);

    if (samePlan && current) {
      await tx.subscription.update({
        where: { id: current.id },
        data: { status: "ACTIVE", endDate, currency: planConfig.currency, providerSubscriptionId: payment.orderId },
      });
    } else {
      await tx.subscription.create({
        data: {
          userId: payment.userId,
          plan: planKey,
          status: "ACTIVE",
          currency: planConfig.currency,
          startDate: new Date(),
          endDate,
          providerSubscriptionId: payment.orderId,
        },
      });
    }
  });

  await createNotification(payment.userId, "SUBSCRIPTION", {
    event: "ACTIVATED",
    plan: planKey,
  });
}

// Revokes access immediately — used when a payment behind an active
// subscription is refunded. Distinct from cancelSubscription, which leaves
// access in place until the term the user already paid for ends.
export async function revokeForRefundedPayment(payment: Payment): Promise<void> {
  await prisma.subscription.updateMany({
    where: { userId: payment.userId, providerSubscriptionId: payment.orderId, status: { in: ["ACTIVE", "CANCELLED"] } },
    data: { status: "REFUNDED", endDate: new Date() },
  });

  await createNotification(payment.userId, "SUBSCRIPTION", { event: "REFUNDED" });
}

// "Cancel" here means "don't treat this as auto-renewing" — there's no
// recurring mandate to stop (see the Payment/Subscription model comments),
// so this only flips status; getEntitlement still honors the already-paid
// endDate.
export async function cancelSubscription(userId: string): Promise<Entitlement> {
  const current = await prisma.subscription.findFirst({
    where: { userId, status: "ACTIVE" },
    orderBy: { endDate: "desc" },
  });

  if (!current || !current.endDate || current.endDate <= new Date()) {
    throw Errors.notFound("Active subscription");
  }

  await prisma.subscription.update({ where: { id: current.id }, data: { status: "CANCELLED" } });
  await createNotification(userId, "SUBSCRIPTION", { event: "CANCELLED", plan: current.plan });

  return getEntitlement(userId);
}
