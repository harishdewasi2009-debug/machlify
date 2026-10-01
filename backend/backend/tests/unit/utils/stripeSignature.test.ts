import { describe, it, expect, vi, afterEach } from "vitest";
import crypto from "node:crypto";
import { verifyStripeSignature } from "../../../src/utils/stripeSignature";

const SECRET = "whsec_test_secret";

function buildHeader(body: Buffer, timestamp: number, secret = SECRET) {
  const signedPayload = `${timestamp}.${body.toString("utf8")}`;
  const signature = crypto.createHmac("sha256", secret).update(signedPayload).digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

describe("verifyStripeSignature", () => {
  afterEach(() => vi.useRealTimers());

  it("passes silently for a correctly signed, recent body", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));
    const body = Buffer.from(JSON.stringify({ type: "identity.verification_session.verified" }));
    const header = buildHeader(body, Math.floor(Date.now() / 1000));
    expect(() => verifyStripeSignature(body, header, SECRET)).not.toThrow();
  });

  it("throws CONFIGURATION_MISSING when no webhook secret is configured", () => {
    const body = Buffer.from("{}");
    const header = buildHeader(body, Math.floor(Date.now() / 1000));
    expect(() => verifyStripeSignature(body, header, "")).toThrowError(/not configured/i);
  });

  it("throws when the header is missing", () => {
    const body = Buffer.from("{}");
    expect(() => verifyStripeSignature(body, undefined, SECRET)).toThrowError(/missing/i);
  });

  it("throws when the header is malformed (no t= or v1=)", () => {
    const body = Buffer.from("{}");
    expect(() => verifyStripeSignature(body, "garbage-header", SECRET)).toThrowError(/malformed/i);
  });

  it("throws when the signature doesn't match the body (tampered payload)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));
    const body = Buffer.from(JSON.stringify({ type: "identity.verification_session.verified" }));
    const header = buildHeader(body, Math.floor(Date.now() / 1000));
    const tamperedBody = Buffer.from(JSON.stringify({ type: "identity.verification_session.canceled" }));
    expect(() => verifyStripeSignature(tamperedBody, header, SECRET)).toThrowError(/invalid/i);
  });

  it("throws when the timestamp is outside the tolerance window (replay protection)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));
    const body = Buffer.from(JSON.stringify({ type: "identity.verification_session.verified" }));
    const staleTimestamp = Math.floor(Date.now() / 1000) - 10 * 60; // 10 minutes old, tolerance is 5
    const header = buildHeader(body, staleTimestamp);
    expect(() => verifyStripeSignature(body, header, SECRET)).toThrowError(/tolerance/i);
  });
});
