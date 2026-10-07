import rateLimit from "express-rate-limit";

// Note: in a multi-instance deployment, back express-rate-limit with a Redis
// store (rate-limit-redis) so limits are shared across instances instead of
// tracked per-process.

export const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: "RATE_LIMITED", message: "Too many login attempts. Try again later." } },
});

export const registerRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
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
  limit: 10,
  // Only failed attempts count. Previously every login (even successful ones) used up the
  // 5-per-15-minutes budget, so signing in/out a few times locked the real admin out.
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: "RATE_LIMITED", message: "Too many login attempts. Try again later." } },
});

const rateLimitedBody = (message: string) => ({ success: false, error: { code: "RATE_LIMITED", message } });
// Unit/integration tests fire many requests from one fake IP; the dedicated limiters above
// are still exercised there, but these broad ones are skipped so they can't cause flakiness.
const skipInTests = () => process.env.NODE_ENV === "test";

// Broad safety net for the whole API (scraping, enumeration, request floods).
export const apiRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.API_RATE_LIMIT_PER_MIN ?? 240),
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTests,
  message: rateLimitedBody("Too many requests. Slow down and try again shortly."),
});

// Refresh-token and email-token endpoints are unauthenticated and guessable-by-volume.
export const tokenEndpointRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTests,
  message: rateLimitedBody("Too many requests. Try again later."),
});

// Uploads are CPU/memory/storage heavy (image processing, face checks).
export const uploadRateLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 40,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTests,
  message: rateLimitedBody("Too many uploads. Try again in a few minutes."),
});

// Chat spam / harassment brake for the REST send endpoints (sockets have their own, see socket.ts).
export const messageRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTests,
  message: rateLimitedBody("You're sending messages too fast."),
});

// Reports are an abuse vector (mass-reporting a user to trigger auto-bans).
export const reportRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTests,
  message: rateLimitedBody("Too many reports. Try again later."),
});

// Every checkout creates a real order at Razorpay, so cap how fast one client can do it.
export const checkoutRateLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 15,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTests,
  message: rateLimitedBody("Too many checkout attempts. Try again in a few minutes."),
});
