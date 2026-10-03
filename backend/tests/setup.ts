// Runs once before each test file's own imports are evaluated. `src/config/env.ts`
// validates `process.env` with zod at import time and throws if anything required
// is missing, so every value it needs without a default must be set here — real
// tests never touch a real database or send a real email; nothing here needs to
// resolve to anything reachable, it only has to satisfy the schema.
process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/matchify_test";
process.env.APP_ORIGIN ??= "https://app.matchify.test";
process.env.COOKIE_DOMAIN ??= "matchify.test";
process.env.JWT_ACCESS_SECRET ??= "test-access-secret-do-not-use-in-prod-0001";
process.env.JWT_REFRESH_SECRET ??= "test-refresh-secret-do-not-use-in-prod-0002";
process.env.REQUIRE_IDENTITY_VERIFICATION ??= "true";
process.env.EMAIL_FROM ??= "no-reply@matchify.test";

// Left unset (empty-string default in the schema itself) unless a specific test
// suite needs a provider "configured": SMTP_*, GOOGLE_CLIENT_*, S3_*,
// MODERATION_*, STRIPE_*, RAZORPAY_*, VAPID_*, TURN_*, ADMIN_JWT_SECRET. A test
// that needs one of these set should set it locally, ideally via `vi.stubEnv`
// and `vi.unstubAllEnvs()` in an `afterEach`, not by adding it here — keeping
// the shared defaults "unconfigured" is what lets the CONFIGURATION_MISSING
// tests in auth/payment/verification specs stay meaningful.
