-- 004: Random Talk (ephemeral, mutual-consent sessions).

CREATE TABLE IF NOT EXISTS random_sessions (
  id SERIAL PRIMARY KEY,
  user_a INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended','skipped','kept','reported')),
  a_keep BOOLEAN NOT NULL DEFAULT false,
  b_keep BOOLEAN NOT NULL DEFAULT false,
  a_voice BOOLEAN NOT NULL DEFAULT false,
  b_voice BOOLEAN NOT NULL DEFAULT false,
  a_video BOOLEAN NOT NULL DEFAULT false,
  b_video BOOLEAN NOT NULL DEFAULT false,
  ended_by INTEGER,
  match_id INTEGER REFERENCES matches(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  ended_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_random_sessions_users ON random_sessions(user_a, user_b, created_at DESC);

CREATE TABLE IF NOT EXISTS random_messages (
  id BIGSERIAL PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES random_sessions(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  moderation_flag TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_random_messages_session ON random_messages(session_id, created_at);

CREATE TABLE IF NOT EXISTS random_skips (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  other_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_random_skips_user ON random_skips(user_id, created_at DESC);
