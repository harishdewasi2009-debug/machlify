import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword, isPasswordStrongEnough } from "../../../src/utils/password";

describe("password hashing", () => {
  it("never stores the plaintext — the hash differs from the input", async () => {
    const hash = await hashPassword("correct-horse-1");
    expect(hash).not.toBe("correct-horse-1");
  });

  it("verifyPassword succeeds for the correct plaintext", async () => {
    const hash = await hashPassword("correct-horse-1");
    expect(await verifyPassword("correct-horse-1", hash)).toBe(true);
  });

  it("verifyPassword fails for an incorrect plaintext", async () => {
    const hash = await hashPassword("correct-horse-1");
    expect(await verifyPassword("wrong-password-1", hash)).toBe(false);
  });

  it("produces a different hash each time (bcrypt salts per-call)", async () => {
    const a = await hashPassword("same-password-1");
    const b = await hashPassword("same-password-1");
    expect(a).not.toBe(b);
    // Both still verify against the same plaintext.
    expect(await verifyPassword("same-password-1", a)).toBe(true);
    expect(await verifyPassword("same-password-1", b)).toBe(true);
  });
});

describe("isPasswordStrongEnough", () => {
  it("rejects passwords shorter than 10 characters", () => {
    expect(isPasswordStrongEnough("ab1cd2ef3")).toBe(false); // 9 chars
  });

  it("rejects passwords with no digit", () => {
    expect(isPasswordStrongEnough("onlylettershere")).toBe(false);
  });

  it("rejects passwords with no letter", () => {
    expect(isPasswordStrongEnough("1234567890")).toBe(false);
  });

  it("accepts a password meeting length + letter + digit requirements", () => {
    expect(isPasswordStrongEnough("Sw1ftMatch99")).toBe(true);
  });

  it("accepts exactly 10 characters with a letter and a digit", () => {
    expect(isPasswordStrongEnough("abcdefghi1")).toBe(true);
  });
});
