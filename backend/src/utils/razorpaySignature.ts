import crypto from "node:crypto";
import { Errors } from "./apiError";

// Checkout confirmation signature, per Razorpay's docs:
// https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/build-integration/#step-6-verify-payment-signature
// HMAC-SHA256("{order_id}|{payment_id}", key_secret). This is what makes
// POST /api/payments/verify trustworthy on its own — it is a cryptographic
// proof from Razorpay, not "the frontend said it worked" — though the
// webhook below still runs as an independent, authoritative backstop.
export function verifyPaymentSignature(params: {
  orderId: string;
  paymentId: string;
  signature: string;
  secret: string;
}): boolean {
  const { orderId, paymentId, signature, secret } = params;
  const expected = crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");

  const expectedBuf = Buffer.from(expected, "hex");
  const signatureBuf = Buffer.from(signature, "hex");
  return expectedBuf.length === signatureBuf.length && crypto.timingSafeEqual(expectedBuf, signatureBuf);
}

// Webhook signature, per https://razorpay.com/docs/webhooks/validate-test/
// HMAC-SHA256 of the exact raw request body, hex-encoded, in the
// X-Razorpay-Signature header. Unlike Stripe there is no timestamp
// component, so replay protection here comes entirely from
// PaymentWebhookEvent's body-hash idempotency check in payment.service, not
// from a tolerance window.
export function verifyWebhookSignature(rawBody: Buffer, signatureHeader: string | undefined, secret: string): void {
  if (!secret) throw Errors.configurationMissing("Payments webhook");
  if (!signatureHeader) throw Errors.validation("Missing X-Razorpay-Signature header.");

  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");

  const expectedBuf = Buffer.from(expected, "hex");
  const signatureBuf = Buffer.from(signatureHeader, "hex");
  const valid =
    expectedBuf.length === signatureBuf.length && crypto.timingSafeEqual(expectedBuf, signatureBuf);

  if (!valid) throw Errors.validation("Invalid webhook signature.");
}
