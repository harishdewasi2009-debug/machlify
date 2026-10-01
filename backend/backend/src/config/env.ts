import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  APP_ORIGIN: z.string().url(),
  COOKIE_DOMAIN: z.string().min(1),

  JWT_ACCESS_SECRET: z.string().min(16, "JWT_ACCESS_SECRET must be set to a real secret"),
  JWT_REFRESH_SECRET: z.string().min(16, "JWT_REFRESH_SECRET must be set to a real secret"),
  ACCESS_TOKEN_TTL_MIN: z.coerce.number().default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(30),

  GOOGLE_CLIENT_ID: z.string().optional().default(""),
  GOOGLE_CLIENT_SECRET: z.string().optional().default(""),

  EMAIL_FROM: z.string().min(1),
  SMTP_HOST: z.string().optional().default(""),
  SMTP_PORT: z.coerce.number().optional().default(587),
  SMTP_USER: z.string().optional().default(""),
  SMTP_PASSWORD: z.string().optional().default(""),

  MIN_AGE_YEARS: z.coerce.number().default(18),
  ACCOUNT_LOCK_THRESHOLD: z.coerce.number().default(5),
  ACCOUNT_LOCK_MINUTES: z.coerce.number().default(15),

  // How long a requested account deletion stays cancelable before the
  // purge script (npm run account:purge) permanently anonymizes the
  // account. Login is disabled immediately on request regardless of this
  // window — cancellation happens via the emailed restore link, not by
  // logging back in.
  ACCOUNT_DELETION_GRACE_DAYS: z.coerce.number().default(14),

  // Object storage (S3 or an S3-compatible provider such as Cloudflare R2)
  S3_ENDPOINT: z.string().optional().default(""), // leave blank for real AWS S3
  S3_REGION: z.string().optional().default("auto"),
  S3_ACCESS_KEY: z.string().optional().default(""),
  S3_SECRET_KEY: z.string().optional().default(""),
  S3_BUCKET: z.string().optional().default(""),
  S3_PUBLIC_BASE_URL: z.string().optional().default(""), // CDN/public base URL, if bucket is public

  // Photo moderation provider (Sightengine — https://sightengine.com)
  MODERATION_API_USER: z.string().optional().default(""),
  MODERATION_API_SECRET: z.string().optional().default(""),
  MODERATION_REJECT_THRESHOLD: z.coerce.number().default(0.8),
  MODERATION_REVIEW_THRESHOLD: z.coerce.number().default(0.4),

  MAX_PHOTO_SIZE_MB: z.coerce.number().default(8),
  MAX_PHOTOS_PER_USER: z.coerce.number().default(9),

  // Identity verification (Stripe Identity — https://stripe.com/identity)
  STRIPE_SECRET_KEY: z.string().optional().default(""),
  STRIPE_IDENTITY_WEBHOOK_SECRET: z.string().optional().default(""),
  // When true (the default), a user must be VERIFIED before they can appear
  // in or browse discovery. Set to "false" only in development while Stripe
  // Identity isn't configured yet — never in production.
  REQUIRE_IDENTITY_VERIFICATION: z
    .string()
    .optional()
    .default("true")
    .transform((v) => v !== "false"),

  // Voice/video calling. STUN alone is not reliable in production (it fails
  // for a large fraction of real users behind symmetric NAT/corporate
  // firewalls) — a TURN relay is required. This targets any coturn-compatible
  // server using the standard time-limited REST credential scheme, so no
  // vendor SDK is needed; a hosted TURN provider (e.g. Twilio, Cloudflare
  // Calls, Metered) that implements the same scheme also works.
  TURN_URLS: z.string().optional().default(""), // comma-separated, e.g. "turn:turn.matchify.example:3478,turns:turn.matchify.example:5349"
  STUN_URLS: z.string().optional().default("stun:stun.l.google.com:19302"),
  TURN_SECRET: z.string().optional().default(""), // shared secret configured on the TURN server (coturn: static-auth-secret)
  TURN_CREDENTIAL_TTL_SECONDS: z.coerce.number().default(600),
  CALL_RING_TIMEOUT_SECONDS: z.coerce.number().default(45),

  // Push notifications (Web Push / VAPID). Generate a keypair with
  // `npx web-push generate-vapid-keys` — the private key must never reach
  // the frontend; the public key is safe to expose (it's what the browser's
  // pushManager.subscribe() call needs).
  VAPID_PUBLIC_KEY: z.string().optional().default(""),
  VAPID_PRIVATE_KEY: z.string().optional().default(""),
  VAPID_SUBJECT: z.string().optional().default(""), // "mailto:support@matchify.example" or "https://matchify.example"

  // Payments (Razorpay — https://razorpay.com). No SDK dependency: orders
  // are created with a plain authenticated fetch (same style as the
  // Sightengine/Stripe-Identity integrations), and both the checkout
  // signature and the webhook signature are verified with Node's own
  // crypto per Razorpay's documented HMAC-SHA256 schemes.
  RAZORPAY_KEY_ID: z.string().optional().default(""),
  RAZORPAY_KEY_SECRET: z.string().optional().default(""),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional().default(""),

  // Admin dashboard auth. Deliberately a separate secret from
  // JWT_ACCESS_SECRET (see AdminSession's schema comment) — never reuse the
  // end-user secret here. Generate with `openssl rand -hex 32`, same as the
  // user-facing secrets.
  ADMIN_JWT_SECRET: z.string().optional().default(""),
  ADMIN_SESSION_TTL_HOURS: z.coerce.number().default(12),
  ADMIN_LOGIN_LOCK_THRESHOLD: z.coerce.number().default(5),

  // Random Chat. Tunables only — none of these change what data is exposed.
  RC_QUEUE_STALE_SECONDS: z.coerce.number().default(45), // no heartbeat for this long => dropped from queue
  RC_QUEUE_FRESH_SECONDS: z.coerce.number().default(25), // only queue rows with a heartbeat this recent can be matched
  RC_WAIT_TIMEOUT_SECONDS: z.coerce.number().default(90), // give up and tell the user nobody is available
  RC_SESSION_STALE_SECONDS: z.coerce.number().default(60), // a participant silent this long => session ended
  RC_REMATCH_COOLDOWN_MINUTES: z.coerce.number().default(60), // same pair can't be re-matched inside this window
  RC_MAX_SESSIONS_PER_HOUR: z.coerce.number().default(40),
  RC_MSG_BURST: z.coerce.number().default(6), // messages allowed per RC_MSG_WINDOW_SECONDS
  RC_MSG_WINDOW_SECONDS: z.coerce.number().default(8),
  RC_MAX_MESSAGE_LENGTH: z.coerce.number().default(1000),
  RC_MESSAGE_RETENTION_DAYS: z.coerce.number().default(30), // ended-session messages are purged after this
  RC_AUTO_BAN_REPORTERS: z.coerce.number().default(3), // distinct reporters in 24h that trigger an automatic temp ban
  RC_AUTO_BAN_HOURS: z.coerce.number().default(24),
  // Optional CAPTCHA (Cloudflare Turnstile). Unset = no CAPTCHA step; the
  // rate limits and auto-bans above still apply.
  // Off by default. When true, ADMIN-role staff can read the messages of a session that has an open report against it (audit-logged). Enable only once your privacy policy and local law allow it.
  RC_ADMIN_CAN_VIEW_REPORTED_MESSAGES: z.string().optional().default("false").transform((v) => v === "true"),
  TURNSTILE_SECRET_KEY: z.string().optional().default(""),
  TURNSTILE_SITE_KEY: z.string().optional().default(""), // public; handed to the frontend to render the widget
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Fail loudly at boot. Never fall back to a default secret in place of a
  // missing one — that would silently run production with a guessable key.
  console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
  throw new Error("Environment validation failed. Check .env against .env.example.");
}

if (parsed.data.JWT_ACCESS_SECRET === parsed.data.JWT_REFRESH_SECRET) {
  throw new Error("JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different values.");
}

export const env = parsed.data;

export const isProduction = env.NODE_ENV === "production";

export const emailConfigured = Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASSWORD);
export const googleOAuthConfigured = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
export const storageConfigured = Boolean(env.S3_ACCESS_KEY && env.S3_SECRET_KEY && env.S3_BUCKET);
export const moderationConfigured = Boolean(env.MODERATION_API_USER && env.MODERATION_API_SECRET);
export const verificationConfigured = Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_IDENTITY_WEBHOOK_SECRET);
export const turnConfigured = Boolean(env.TURN_URLS && env.TURN_SECRET);
export const pushConfigured = Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT);
export const razorpayConfigured = Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);
export const razorpayWebhookConfigured = Boolean(env.RAZORPAY_WEBHOOK_SECRET);
export const adminAuthConfigured = Boolean(env.ADMIN_JWT_SECRET);

if (isProduction && env.ADMIN_JWT_SECRET && env.ADMIN_JWT_SECRET === env.JWT_ACCESS_SECRET) {
  // A shared secret would let a forged/leaked user access token double as
  // an admin token (or vice versa) if the JWT payload shapes ever overlap —
  // fail loudly rather than silently accept the risk.
  throw new Error("ADMIN_JWT_SECRET must differ from JWT_ACCESS_SECRET.");
}
