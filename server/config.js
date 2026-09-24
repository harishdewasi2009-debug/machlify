// Central configuration. Environment-dependent flags are FUNCTIONS so tests
// (and safety guards) always see the live environment.

const env = process.env;

const isProd = () => env.NODE_ENV === 'production';
const flag = (name, dflt) => (env[name] === undefined || env[name] === '' ? dflt : env[name] === 'true');

// ---- Plans, pricing (paise) and entitlements. Edit here — not in routes. ----
// null = unlimited.
const PLAN_RANK = { free: 0, day_pass: 1, plus: 2, premium: 3, pro: 4 };

const PLAN_ENTITLEMENTS = {
  free:     { likesPerDay: 25,   superlikesPerDay: 1,  rewind: false, advancedFilters: false, seeLikes: false, whoViewed: false, incognito: false, priority: false, monthlyBoosts: 0, aiIcebreakers: false, translate: false, aiTalk: false, recommendationBatches: 1, recommendationSize: 10 },
  day_pass: { likesPerDay: null, superlikesPerDay: 3,  rewind: false, advancedFilters: false, seeLikes: false, whoViewed: false, incognito: false, priority: false, monthlyBoosts: 0, aiIcebreakers: false, translate: false, aiTalk: false, recommendationBatches: 1, recommendationSize: 10 },
  plus:     { likesPerDay: 100,  superlikesPerDay: 3,  rewind: true,  advancedFilters: true,  seeLikes: false, whoViewed: false, incognito: false, priority: false, monthlyBoosts: 0, aiIcebreakers: false, translate: false, aiTalk: false, recommendationBatches: 2, recommendationSize: 15 },
  premium:  { likesPerDay: null, superlikesPerDay: 5,  rewind: true,  advancedFilters: true,  seeLikes: true,  whoViewed: true,  incognito: false, priority: false, monthlyBoosts: 1, aiIcebreakers: true,  translate: false, aiTalk: false, recommendationBatches: 3, recommendationSize: 20 },
  pro:      { likesPerDay: null, superlikesPerDay: 10, rewind: true,  advancedFilters: true,  seeLikes: true,  whoViewed: true,  incognito: true,  priority: true,  monthlyBoosts: 1, aiIcebreakers: true,  translate: true,  aiTalk: true,  recommendationBatches: 3, recommendationSize: 25 },
};

const PRODUCTS = {
  plus_monthly:    { kind: 'subscription', plan: 'plus',    months: 1,  amount: 19900, label: 'Plus — monthly' },
  premium_monthly: { kind: 'subscription', plan: 'premium', months: 1,  amount: 39900, label: 'Premium — monthly' },
  pro_monthly:     { kind: 'subscription', plan: 'pro',     months: 1,  amount: 69900, label: 'Pro — monthly' },
  premium_3m:      { kind: 'pack', plan: 'premium', months: 3,  amount: 99900,  label: 'Premium — 3 months (prepaid)' },
  premium_6m:      { kind: 'pack', plan: 'premium', months: 6,  amount: 159900, label: 'Premium — 6 months (prepaid)' },
  premium_12m:     { kind: 'pack', plan: 'premium', months: 12, amount: 249900, label: 'Premium — 12 months (prepaid)' },
  boost_1:         { kind: 'boost', credits: 1, amount: 4900,  label: '1 Boost' },
  boost_3:         { kind: 'boost', credits: 3, amount: 11900, label: '3 Boosts' },
  boost_5:         { kind: 'boost', credits: 5, amount: 17900, label: '5 Boosts' },
  day_pass:        { kind: 'pass', plan: 'day_pass', hours: 24, amount: 5000, label: 'Day Pass (24h)', optional: true },
};

module.exports = {
  BRAND_NAME: env.BRAND_NAME || 'Matchify',
  MAX_PROFILE_PHOTOS: 9,
  MIN_PROFILE_PHOTOS: 2,
  PLAN_RANK, PLAN_ENTITLEMENTS, PRODUCTS,
  PLANS: Object.keys(PLAN_RANK),
  DAY_PASS_ENABLED: () => flag('DAY_PASS_ENABLED', false),

  MIN_AGE: 18,
  MAX_AGE: 100,
  MAX_BIO_LENGTH: 500,
  MAX_INTERESTS: 15,
  MAX_PROMPTS: 3,
  MAX_PROMPT_ANSWER: 150,
  BOOST_MINUTES: 30,
  REWIND_WINDOW_MINUTES: 5,
  NEW_USER_DAYS: 14,
  DAY_TZ: env.DAY_TZ || 'Asia/Kolkata',   // "daily" caps reset at local midnight

  PROMPT_KEYS: [
    'ideal_sunday', 'two_truths', 'looking_for', 'perfect_first_date', 'unpopular_opinion',
    'cant_live_without', 'best_travel_story', 'weekend_spot', 'green_flag', 'ask_me_about',
  ],
  INTENTS: ['long_term', 'short_term', 'friends', 'marriage', 'figuring_out'],
  GENDERS: ['woman', 'man', 'nonbinary', 'other'],

  // Ranking weights (sum of compatibility weights = 1).
  RANKING: {
    interests: 0.35, ageFit: 0.15, distanceFit: 0.15, recency: 0.15, completeness: 0.10, verified: 0.05, likedMe: 0.05,
    boostBonus: 50, priorityBonus: 10,
  },

  // Chat / calls
  MESSAGE_MAX_LENGTH: 2000,
  MESSAGES_PER_MINUTE: 30,
  CALLS_REQUIRE_MESSAGES: () => flag('CALLS_REQUIRE_MESSAGES', true),
  CALL_INVITES_PER_MINUTE: 6,
  MESSAGE_RETENTION_DAYS: 90,

  // Random Talk
  RANDOM_QUEUE_TIMEOUT_MS: 5 * 60 * 1000,
  RANDOM_SKIPS_PER_HOUR: 20,
  RANDOM_SKIP_MEMORY_MINUTES: 60,
  RANDOM_MESSAGE_RETENTION_DAYS: 30,

  // AI
  AI_TALK_DAILY_LIMIT: parseInt(env.AI_TALK_DAILY_LIMIT || '60', 10),
  AI_DAILY_LIMITS: { bio: 20, review: 20, icebreakers: 40, compat: 200, translate: 100, companion: parseInt(env.AI_TALK_DAILY_LIMIT || '60', 10) },

  // Verification
  VERIFICATION_STATUSES: ['unverified', 'pending', 'verified', 'rejected'],
  REQUIRE_AGE_VERIFICATION: () => flag('REQUIRE_AGE_VERIFICATION', true),
  VERIFICATION_PROVIDER: () => (env.VERIFICATION_PROVIDER || '').toLowerCase(),

  // Demo data: visible ONLY when DEMO_MODE=true AND not production.
  DEMO_MODE: () => flag('DEMO_MODE', false),
  demoVisible: () => flag('DEMO_MODE', false) && !isProd(),
  isProd,

  // Lifecycle
  DELETION_GRACE_DAYS: 30,
  INACTIVE_NOTICE_DAYS: parseInt(env.INACTIVE_NOTICE_DAYS || '180', 10),
  INACTIVE_HIDE_AFTER_NOTICE_DAYS: 30,
  INACTIVE_DELETE_DAYS: parseInt(env.INACTIVE_DELETE_DAYS || '365', 10),
  SAFETY_RECORD_RETENTION_DAYS: 365 * 2,

  // Auth
  ACCESS_TOKEN_TTL: env.ACCESS_TOKEN_TTL || '30m',
  REFRESH_TTL_DAYS: 30,
  MAX_FAILED_LOGINS: 8,
  LOCKOUT_MINUTES: 15,
  REQUIRE_STAFF_2FA: () => flag('REQUIRE_STAFF_2FA', isProd()),
  RATE_LIMIT_DISABLED: () => env.RATE_LIMIT_DISABLED === 'true',

  LEGAL_VERSION: '2026-09-draft',

  // Called once at boot. Throws (→ process exits) on unsafe production config.
  assertProductionSafe() {
    const problems = [];
    const dflt = (v) => !v || /change-this|change_me|secret$/i.test(v) || v.length < 32;
    if (isProd()) {
      if (flag('DEMO_MODE', false)) problems.push('DEMO_MODE=true is not allowed when NODE_ENV=production.');
      if (dflt(env.JWT_SECRET)) problems.push('JWT_SECRET must be a random string of 32+ characters.');
      if (dflt(env.REFRESH_SECRET)) problems.push('REFRESH_SECRET must be a random string of 32+ characters.');
      if (!env.APP_ORIGIN) problems.push('APP_ORIGIN must be set (e.g. https://matchify.example.com).');
      if (flag('REQUIRE_AGE_VERIFICATION', true)) {
        const p = (env.VERIFICATION_PROVIDER || '').toLowerCase();
        if (!p || p === 'mock' || p === 'none') problems.push('REQUIRE_AGE_VERIFICATION is on but VERIFICATION_PROVIDER is not a real provider (persona | generic).');
        if (!env.VERIFICATION_WEBHOOK_SECRET) problems.push('VERIFICATION_WEBHOOK_SECRET is required.');
      } else {
        problems.push('REQUIRE_AGE_VERIFICATION=false is not allowed in production for an 18+ platform.');
      }
      if (env.PAYMENTS_DEV_MODE === 'true') problems.push('PAYMENTS_DEV_MODE must not be enabled in production.');
    }
    if (problems.length) {
      const e = new Error('Unsafe production configuration:\n - ' + problems.join('\n - '));
      e.code = 'UNSAFE_CONFIG';
      throw e;
    }
  },
};
