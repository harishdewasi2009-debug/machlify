import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { verifyPaymentSignature, verifyWebhookSignature } from "../../../src/utils/razorpaySignature";

const SECRET = "test_razorpay_secret";

function signCheckout(orderId: string, paymentId: string, secret = SECRET) {
  return crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");
}

describe("verifyPaymentSignature (checkout confirmation)", () => {
  it("accepts a correctly computed signature", () => {
    const signature = signCheckout("order_1", "pay_1");
    expect(
      verifyPaymentSignature({ orderId: "order_1", paymentId: "pay_1", signature, secret: SECRET })
    ).toBe(true);
  });

  it("rejects a signature computed with the wrong secret (forged by someone without the key)", () => {
    const signature = signCheckout("order_1", "pay_1", "wrong_secret");
    expect(
      verifyPaymentSignature({ orderId: "order_1", paymentId: "pay_1", signature, secret: SECRET })
    ).toBe(false);
  });

  it("rejects a signature for a different order/payment id pair (can't be replayed across payments)", () => {
    const signature = signCheckout("order_1", "pay_1");
    expect(
      verifyPaymentSignature({ orderId: "order_2", paymentId: "pay_1", signature, secret: SECRET })
    ).toBe(false);
  });

  it("does not throw on a malformed/non-hex signature — just returns false", () => {
    expect(
      verifyPaymentSignature({
        orderId: "order_1",
        paymentId: "pay_1",
        signature: "not-hex-at-all!!",
        secret: SECRET,
      })
    ).toBe(false);
  });
});

describe("verifyWebhookSignature", () => {
  function sign(body: Buffer, secret = SECRET) {
    return crypto.createHmac("sha256", secret).update(body).digest("hex");
  }

  it("passes silently for a correctly signed body", () => {
    const body = Buffer.from(JSON.stringify({ event: "payment.captured" }));
    expect(() => verifyWebhookSignature(body, sign(body), SECRET)).not.toThrow();
  });

  it("throws CONFIGURATION_MISSING when no webhook secret is configured", () => {
    const body = Buffer.from("{}");
    expect(() => verifyWebhookSignature(body, sign(body), "")).toThrowError(/not configured/i);
  });

  it("throws VALIDATION_ERROR when the header is missing", () => {
    const body = Buffer.from("{}");
    expect(() => verifyWebhookSignature(body, undefined, SECRET)).toThrowError(/missing/i);
  });

  it("throws on an invalid signature (e.g. tampered body)", () => {
    const body = Buffer.from(JSON.stringify({ event: "payment.captured" }));
    const tamperedBody = Buffer.from(JSON.stringify({ event: "payment.captured", amount: 999999 }));
    expect(() => verifyWebhookSignature(tamperedBody, sign(body), SECRET)).toThrowError(/invalid/i);
  });
});
