import rateLimit from "express-rate-limit";

// Note: in a multi-instance deployment, back express-rate-limit with a Redis
// store (rate-limit-redis) so limits are shared across instances instead of
// tracked per-process.

export const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: "RATE_LIMITED", message: "Too many login attempts. Try again later." } },
});

export const registerRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: "RATE_LIMITED", message: "Too many registration attempts. Try again later." } },
});

export const passwordResetRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: "RATE_LIMITED", message: "Too many requests. Try again later." } },
});

// Tighter than the end-user login limiter — an admin login endpoint is a
// higher-value brute-force target than an ordinary account.
export const adminLoginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: "RATE_LIMITED", message: "Too many login attempts. Try again later." } },
});
