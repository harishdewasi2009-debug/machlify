import crypto from "node:crypto";
import { Errors } from "./apiError";

const TOLERANCE_SECONDS = 5 * 60;

// Implements Stripe's documented signing scheme directly (HMAC-SHA256 over
// "{timestamp}.{rawBody}", header shaped like "t=...,v1=..."), since no
// Stripe SDK is installed here. See
// https://docs.stripe.com/webhooks#verify-manually
export function verifyStripeSignature(rawBody: Buffer, signatureHeader: string | undefined, secret: string): void {
  if (!secret) throw Errors.configurationMissing("Identity verification");
  if (!signatureHeader) throw Errors.validation("Missing Stripe-Signature header.");

  const parts = Object.fromEntries(
    signatureHeader.split(",").map((kv) => {
      const [key, value] = kv.split("=");
      return [key, value] as [string, string];
    })
  );

  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) throw Errors.validation("Malformed Stripe-Signature header.");

  const signedPayload = `${timestamp}.${rawBody.toString("utf8")}`;
  const expected = crypto.createHmac("sha256", secret).update(signedPayload).digest("hex");

  const expectedBuf = Buffer.from(expected, "hex");
  const signatureBuf = Buffer.from(signature, "hex");
  const valid =
    expectedBuf.length === signatureBuf.length && crypto.timingSafeEqual(expectedBuf, signatureBuf);
  if (!valid) throw Errors.validation("Invalid webhook signature.");

  // Basic replay protection, mirroring Stripe's own recommended tolerance.
  const eventTime = Number(timestamp);
  if (!Number.isFinite(eventTime) || Math.abs(Date.now() / 1000 - eventTime) > TOLERANCE_SECONDS) {
    throw Errors.validation("Webhook timestamp outside tolerance.");
  }
}
