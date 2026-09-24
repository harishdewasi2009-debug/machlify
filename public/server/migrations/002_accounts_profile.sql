-- 002: accounts, profile, photos, prompts, auth tokens, sessions, privacy.

ALTER TABLE users ADD COLUMN IF NOT EXISTS dob DATE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';
ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE users ADD COLUMN IF NOT EXISTS status_reason TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_until TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE users ADD COLUMN IF NOT EXISTS interest_tags TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN IF NOT EXISTS pref_genders TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN IF NOT EXISTS pref_age_min INTEGER NOT NULL DEFAULT 18;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pref_age_max INTEGER NOT NULL DEFAULT 60;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pref_distance_km INTEGER NOT NULL DEFAULT 100;
ALTER TABLE users ADD COLUMN IF NOT EXISTS relationship_intent TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS height_cm INTEGER;
ALTER TABLE users ADD COLUMN IF NOT EXISTS language TEXT DEFAULT 'en';
ALTER TABLE users ADD COLUMN IF NOT EXISTS show_distance BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS show_online BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS read_receipts BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS incognito BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS discoverable BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS hidden_reason TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_strength INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_verified BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_verified_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS over_18 BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS risk_score INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS risk_level TEXT NOT NULL DEFAULT 'low';
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS tos_accepted_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS privacy_version TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deletion_scheduled_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS demo_batch TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS boost_credits INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS free_boost_period TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS notification_prefs JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE users ADD COLUMN IF NOT EXISTS random_rules_accepted_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS inactive_notice_sent_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_logins INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS staff_totp_secret TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS staff_totp_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_ip TEXT;

-- Normalise legacy gender values.
UPDATE users SET gender='woman' WHERE LOWER(gender) IN ('female','woman','women');
UPDATE users SET gender='man'   WHERE LOWER(gender) IN ('male','man','men');
UPDATE users SET gender='nonbinary' WHERE LOWER(gender) IN ('nonbinary','non-binary','enby');
UPDATE users SET interest_tags = COALESCE(
  (SELECT ARRAY(SELECT LOWER(TRIM(x)) FROM jsonb_array_elements_text(users.interests::jsonb) x)),
  '{}') WHERE interests IS NOT NULL AND interests LIKE '[%' AND interest_tags = '{}';
UPDATE users SET pref_genders = CASE LOWER(COALESCE(interested_in,'everyone'))
  WHEN 'women' THEN ARRAY['woman'] WHEN 'men' THEN ARRAY['man'] ELSE '{}'::text[] END
  WHERE pref_genders = '{}';

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_google_id ON users(google_id) WHERE google_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_phone ON users(phone) WHERE phone IS NOT NULL AND phone_verified_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_last_active ON users(last_active_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
CREATE INDEX IF NOT EXISTS idx_users_country ON users(LOWER(country));
CREATE INDEX IF NOT EXISTS idx_users_city ON users(LOWER(location));
CREATE INDEX IF NOT EXISTS idx_users_geo ON users(lat, lng);
CREATE INDEX IF NOT EXISTS idx_users_interest_tags ON users USING GIN(interest_tags);
CREATE INDEX IF NOT EXISTS idx_users_demo ON users(is_demo);
CREATE INDEX IF NOT EXISTS idx_users_created ON users(created_at DESC);

-- Age helper: prefer DOB, fall back to the legacy cached age column.
CREATE OR REPLACE FUNCTION mf_age(dob DATE, fallback INTEGER) RETURNS INTEGER AS $$
  SELECT COALESCE(DATE_PART('year', AGE(dob))::int, fallback)
$$ LANGUAGE SQL STABLE;

-- Great-circle distance in km (no PostGIS / earthdistance dependency).
CREATE OR REPLACE FUNCTION mf_distance_km(lat1 DOUBLE PRECISION, lng1 DOUBLE PRECISION,
                                          lat2 DOUBLE PRECISION, lng2 DOUBLE PRECISION)
RETURNS DOUBLE PRECISION AS $$
  SELECT CASE WHEN lat1 IS NULL OR lng1 IS NULL OR lat2 IS NULL OR lng2 IS NULL THEN NULL
  ELSE 2 * 6371 * ASIN(SQRT(LEAST(1.0,
    POWER(SIN(RADIANS(lat2 - lat1) / 2), 2) +
    COS(RADIANS(lat1)) * COS(RADIANS(lat2)) * POWER(SIN(RADIANS(lng2 - lng1) / 2), 2)))) END
$$ LANGUAGE SQL IMMUTABLE;

CREATE TABLE IF NOT EXISTS photos (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  thumb_url TEXT,
  storage_key TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','needs_review')),
  moderation JSONB,
  phash BIGINT,
  width INTEGER,
  height INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_photos_user ON photos(user_id, position);
CREATE INDEX IF NOT EXISTS idx_photos_status ON photos(status);
CREATE INDEX IF NOT EXISTS idx_photos_phash ON photos(phash) WHERE phash IS NOT NULL;

CREATE TABLE IF NOT EXISTS profile_prompts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  prompt_key TEXT NOT NULL,
  answer TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  UNIQUE(user_id, prompt_key)
);

CREATE TABLE IF NOT EXISTS email_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL CHECK (purpose IN ('verify','reset')),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS otp_codes (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_otp_user ON otp_codes(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sessions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  ip TEXT,
  user_agent TEXT,
  geo_country TEXT,
  device_hash TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_used_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS login_events (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  geo_country TEXT,
  device_hash TEXT,
  new_device BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_login_events_user ON login_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_events_ip ON login_events(ip, kind, created_at DESC);

CREATE TABLE IF NOT EXISTS verifications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('age_id','photo_selfie')),
  provider TEXT NOT NULL,
  session_ref TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','rejected')),
  over_18 BOOLEAN,
  verified_dob DATE,
  reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_verifications_user ON verifications(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS banned_identities (
  id SERIAL PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('email','phone','google')),
  hash TEXT NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(kind, hash)
);
