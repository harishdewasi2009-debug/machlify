-- 006: monetization (Razorpay). Entitlements derive from grants, never client flags.

CREATE TABLE IF NOT EXISTS razorpay_plans (
  product_key TEXT PRIMARY KEY,
  razorpay_plan_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  product_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created','paid','failed','refunded')),
  razorpay_order_id TEXT UNIQUE,
  razorpay_subscription_id TEXT,
  razorpay_payment_id TEXT UNIQUE,
  receipt TEXT,
  fulfilled_at TIMESTAMPTZ,
  refunded_at TIMESTAMPTZ,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_sub ON payments(razorpay_subscription_id);

CREATE TABLE IF NOT EXISTS subscriptions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_key TEXT NOT NULL,
  plan TEXT NOT NULL,
  razorpay_subscription_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'created',
  current_period_end TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id);

-- One row per period of paid access. Effective plan = highest-ranked active grant.
CREATE TABLE IF NOT EXISTS entitlement_grants (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan TEXT NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL,
  payment_id INTEGER REFERENCES payments(id) ON DELETE SET NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_grants_user ON entitlement_grants(user_id, ends_at);

CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  event TEXT,
  received_at TIMESTAMPTZ DEFAULT NOW()
);

-- All plans before this migration came from the old MOCK checkout (nothing was
-- ever charged). Reset them so paid access exists only via verified payments.
UPDATE users SET plan='free', premium=false, plan_expires_at=NULL, billing_cycle=NULL, autopay=false
  WHERE plan IS NOT NULL AND plan <> 'free';
