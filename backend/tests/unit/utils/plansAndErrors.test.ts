import { describe, it, expect } from "vitest";
import { PLANS, isPaidPlan } from "../../../src/utils/plans";
import { Errors, ApiError } from "../../../src/utils/apiError";

describe("PLANS / isPaidPlan", () => {
  it("recognizes every key defined in PLANS as a paid plan", () => {
    for (const key of Object.keys(PLANS)) {
      expect(isPaidPlan(key)).toBe(true);
    }
  });

  it("rejects a plan name that isn't in PLANS", () => {
    expect(isPaidPlan("FREE")).toBe(false);
    expect(isPaidPlan("SUPER_ULTRA_VIP")).toBe(false);
  });

  it("every plan has a positive amount, a currency, and a duration", () => {
    for (const plan of Object.values(PLANS)) {
      expect(plan.amount).toBeGreaterThan(0);
      expect(plan.currency).toBe("INR");
      expect(plan.durationDays).toBeGreaterThan(0);
    }
  });
});

describe("Errors factory", () => {
  it("underMinimumAge produces a 403 with the configured minimum age in the message", () => {
    const err = Errors.underMinimumAge(18);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe("UNDER_MINIMUM_AGE");
    expect(err.message).toContain("18");
  });

  it("configurationMissing includes the named service and uses 503", () => {
    const err = Errors.configurationMissing("Payments webhook");
    expect(err.statusCode).toBe(503);
    expect(err.code).toBe("CONFIGURATION_MISSING");
    expect(err.message).toContain("Payments webhook");
  });

  it("invalidCredentials and notFound never leak which part was wrong", () => {
    // The message may mention "password" generically (that's the standard,
    // non-enumerating phrasing) — what it must never do is single out *which*
    // field was wrong, since that would let an attacker enumerate emails.
    const creds = Errors.invalidCredentials();
    expect(creds.message.toLowerCase()).not.toContain("no account");
    expect(creds.message.toLowerCase()).not.toContain("does not exist");
    expect(creds.message.toLowerCase()).not.toContain("wrong password");
    expect(creds.message.toLowerCase()).not.toContain("incorrect password");

    const notFound = Errors.notFound("Payment");
    expect(notFound.statusCode).toBe(404);
    expect(notFound.message).toBe("Payment not found.");
  });
});
