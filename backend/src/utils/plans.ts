// Single source of truth for what a plan costs and how long it lasts.
// checkout, verify/webhook activation, and GET /api/subscription all read
// from this — a plan can't drift into charging one amount but granting a
// different entitlement.
export const PLANS = {
  PREMIUM: {
    label: "Premium",
    amount: 49900, // smallest currency unit — paise for INR (₹499.00)
    currency: "INR",
    durationDays: 30,
  },
  VIP: {
    label: "VIP",
    amount: 99900, // ₹999.00
    currency: "INR",
    durationDays: 30,
  },
} as const;

export type PaidPlan = keyof typeof PLANS;

export function isPaidPlan(value: string): value is PaidPlan {
  return Object.prototype.hasOwnProperty.call(PLANS, value);
}
