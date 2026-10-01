import { describe, it, expect } from "vitest";
import jwt from "jsonwebtoken";
import {
  signAccessToken,
  verifyAccessToken,
  generateOpaqueToken,
  hashOpaqueToken,
  addDays,
  addMinutes,
} from "../../../src/utils/tokens";

describe("access tokens", () => {
  it("round-trips the payload through sign/verify", () => {
    const token = signAccessToken({ sub: "user_1", sessionId: "session_1" });
    const payload = verifyAccessToken(token);
    expect(payload.sub).toBe("user_1");
    expect(payload.sessionId).toBe("session_1");
  });

  it("rejects a token signed with a different secret", () => {
    // Simulates a forged/foreign token — must not verify against our secret.
    const forged = jwt.sign({ sub: "attacker", sessionId: "x" }, "some-other-secret");
    expect(() => verifyAccessToken(forged)).toThrow();
  });

  it("rejects a tampered token", () => {
    const token = signAccessToken({ sub: "user_1", sessionId: "session_1" });
    const tampered = token.slice(0, -2) + (token.slice(-2) === "aa" ? "bb" : "aa");
    expect(() => verifyAccessToken(tampered)).toThrow();
  });
});

describe("opaque tokens (refresh / email-verification / password-reset)", () => {
  it("generates a raw value and a hash that never equal each other", () => {
    const { raw, hash } = generateOpaqueToken();
    expect(raw).not.toBe(hash);
    expect(raw.length).toBeGreaterThanOrEqual(32);
  });

  it("hashOpaqueToken(raw) matches the hash produced at generation time", () => {
    const { raw, hash } = generateOpaqueToken();
    expect(hashOpaqueToken(raw)).toBe(hash);
  });

  it("produces different raw tokens on every call (no reuse/predictability)", () => {
    const a = generateOpaqueToken();
    const b = generateOpaqueToken();
    expect(a.raw).not.toBe(b.raw);
    expect(a.hash).not.toBe(b.hash);
  });

  it("hashing is deterministic for the same input", () => {
    expect(hashOpaqueToken("same-input")).toBe(hashOpaqueToken("same-input"));
  });
});

describe("date helpers", () => {
  it("addDays moves forward by exactly N * 24h", () => {
    const start = new Date("2026-01-01T00:00:00.000Z");
    const result = addDays(start, 5);
    expect(result.getTime() - start.getTime()).toBe(5 * 24 * 60 * 60 * 1000);
  });

  it("addMinutes moves forward by exactly N minutes", () => {
    const start = new Date("2026-01-01T00:00:00.000Z");
    const result = addMinutes(start, 90);
    expect(result.getTime() - start.getTime()).toBe(90 * 60 * 1000);
  });
});
