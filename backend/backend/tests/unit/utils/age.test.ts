import { describe, it, expect, vi, afterEach } from "vitest";
import { calculateAge, latestBirthDateForMinAge, earliestBirthDateForMaxAge } from "../../../src/utils/age";

describe("calculateAge", () => {
  const REAL_NOW = new Date("2026-06-15T12:00:00.000Z");

  afterEach(() => {
    vi.useRealTimers();
  });

  function freezeNow() {
    vi.useFakeTimers();
    vi.setSystemTime(REAL_NOW);
  }

  it("returns a whole number of years for a birthday already passed this year", () => {
    freezeNow();
    // Turned 30 back in January 2026, "now" is June 2026.
    expect(calculateAge(new Date("1996-01-10"))).toBe(30);
  });

  it("does not count this year's birthday if it hasn't happened yet", () => {
    freezeNow();
    // Birthday is in December — hasn't happened yet relative to June "now".
    expect(calculateAge(new Date("1996-12-25"))).toBe(29);
  });

  it("handles a birthday that falls exactly today as already turned", () => {
    freezeNow();
    expect(calculateAge(new Date("2000-06-15"))).toBe(26);
  });

  it("treats a birthday one day from now as not yet turned", () => {
    freezeNow();
    expect(calculateAge(new Date("2000-06-16"))).toBe(25);
  });

  it("never trusts a client-sent age — this is the only path age is derived from", () => {
    freezeNow();
    // Someone who lies and says they're 18 but was actually born last year
    // must compute to their real (very young) age, not 18.
    expect(calculateAge(new Date("2025-01-01"))).toBe(1);
  });
});

describe("latestBirthDateForMinAge / earliestBirthDateForMaxAge", () => {
  const REAL_NOW = new Date("2026-06-15T00:00:00.000Z");

  afterEach(() => vi.useRealTimers());

  it("produces a DOB boundary that itself calculates to exactly the requested min age", () => {
    vi.useFakeTimers();
    vi.setSystemTime(REAL_NOW);
    const boundary = latestBirthDateForMinAge(18);
    expect(calculateAge(boundary)).toBe(18);
  });

  it("produces a DOB boundary that itself calculates to exactly the requested max age", () => {
    vi.useFakeTimers();
    vi.setSystemTime(REAL_NOW);
    const boundary = earliestBirthDateForMaxAge(35);
    expect(calculateAge(boundary)).toBe(35);
  });
});
