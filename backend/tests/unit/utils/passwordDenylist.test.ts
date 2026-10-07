import { describe, it, expect } from "vitest";
import { isPasswordStrongEnough } from "../../../src/utils/password";

describe("isPasswordStrongEnough — common/low-effort passwords", () => {
  it("rejects top breached passwords even though they have a letter, a digit and 10+ chars", () => {
    expect(isPasswordStrongEnough("password123")).toBe(false);
    expect(isPasswordStrongEnough("Qwerty12345")).toBe(false);
  });

  it("rejects a single repeated character", () => {
    expect(isPasswordStrongEnough("aaaaaaaaa1")).toBe(false);
  });

  it("rejects absurdly long passwords (bcrypt DoS / truncation)", () => {
    expect(isPasswordStrongEnough("a1".repeat(80))).toBe(false);
  });

  it("still accepts a normal strong password", () => {
    expect(isPasswordStrongEnough("Sw1ftMatch99")).toBe(true);
  });
});
