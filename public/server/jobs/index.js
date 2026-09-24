// Background jobs. Safe on multiple instances: a Postgres advisory lock ensures
// only one instance runs a given tick. Each task is exported for tests.
const { pool, one, many, query } = require('../db');
const cfg = require('../config');
const logger = require('../lib/logger');
const payments = require('../services/payments');
const accounts = require('../services/accounts');
const discovery = require('../services/discovery');
const { sendMail } = require('../lib/mailer');

const tasks = {
  async sweepExpiredPlans() { return payments.sweepExpired(); },

  async reactivateSuspensions() {
    const r = await query(`UPDATE users SET status='active', status_reason=NULL, suspended_until=NULL WHERE status='suspended' AND suspended_until IS NOT NULL AND suspended_until < NOW()`);
    return r.rowCount;
  },

  async purgePendingDeletions() {
    const rows = await many(`SELECT id FROM users WHERE status='pending_deletion' AND deletion_scheduled_at < NOW() LIMIT 100`);
    let n = 0; for (const r of rows) if (await accounts.purgeUser(r.id)) n++;
    return n;
  },

  // notice → hide → schedule deletion
  async inactiveCleanup() {
    const notice = await many(`SELECT id, email, name FROM users WHERE is_demo=false AND role='user' AND status='active' AND inactive_notice_sent_at IS NULL
        AND last_active_at < NOW() - ($1 || ' days')::interval LIMIT 200`, [String(cfg.INACTIVE_NOTICE_DAYS)]);
    for (const u of notice) {
      sendMail({ to: u.email, subject: `We miss you on ${cfg.BRAND_NAME}`, text: `Hi ${u.name},\n\nYour profile has been inactive for a while. Log in within ${cfg.INACTIVE_HIDE_AFTER_NOTICE_DAYS} days to keep it visible — otherwise we will hide it. Inactive accounts are eventually deleted.` }).catch(() => {});
      await query('UPDATE users SET inactive_notice_sent_at=NOW() WHERE id=$1', [u.id]);
    }
    const hidden = await query(`UPDATE users SET discoverable=false, hidden_reason='inactive' WHERE is_demo=false AND role='user' AND status='active' AND discoverable=true
        AND inactive_notice_sent_at IS NOT NULL AND inactive_notice_sent_at < NOW() - ($1 || ' days')::interval AND last_active_at < inactive_notice_sent_at`, [String(cfg.INACTIVE_HIDE_AFTER_NOTICE_DAYS)]);
    const del = await query(`UPDATE users SET status='pending_deletion', status_reason='inactive', deletion_scheduled_at=NOW() + INTERVAL '7 days'
        WHERE is_demo=false AND role='user' AND status='active' AND last_active_at < NOW() - ($1 || ' days')::interval AND hidden_reason='inactive'`, [String(cfg.INACTIVE_DELETE_DAYS)]);
    return { noticed: notice.length, hidden: hidden.rowCount, scheduledDeletion: del.rowCount };
  },

  // Returning users become visible again.
  async unhideReturning() {
    const r = await query(`UPDATE users SET discoverable=true, hidden_reason=NULL, inactive_notice_sent_at=NULL WHERE hidden_reason='inactive' AND last_active_at > inactive_notice_sent_at`);
    return r.rowCount;
  },

  async purgeOldContent() {
    const m = await query(`DELETE FROM messages WHERE match_id IN (SELECT id FROM matches WHERE status='closed' AND closed_at < NOW() - ($1 || ' days')::interval)
        AND match_id NOT IN (SELECT match_id FROM reports WHERE match_id IS NOT NULL AND status IN ('open','in_review'))`, [String(cfg.MESSAGE_RETENTION_DAYS)]);
    const r = await query(`DELETE FROM random_messages WHERE created_at < NOW() - ($1 || ' days')::interval`, [String(cfg.RANDOM_MESSAGE_RETENTION_DAYS)]);
    return { messages: m.rowCount, randomMessages: r.rowCount };
  },

  async cleanupTokens() {
    const q = (sql) => query(sql).then((r) => r.rowCount);
    return {
      emailTokens: await q(`DELETE FROM email_tokens WHERE expires_at < NOW() - INTERVAL '2 days'`),
      otps: await q(`DELETE FROM otp_codes WHERE created_at < NOW() - INTERVAL '1 day'`),
      sessions: await q(`DELETE FROM sessions WHERE (revoked_at IS NOT NULL AND revoked_at < NOW() - INTERVAL '30 days') OR expires_at < NOW() - INTERVAL '7 days'`),
      loginEvents: await q(`DELETE FROM login_events WHERE created_at < NOW() - INTERVAL '180 days'`),
      webhookEvents: await q(`DELETE FROM webhook_events WHERE received_at < NOW() - INTERVAL '90 days'`),
      swipeEvents: await q(`DELETE FROM swipe_events WHERE created_at < NOW() - INTERVAL '60 days'`),
      profileViews: await q(`DELETE FROM profile_views WHERE created_at < NOW() - INTERVAL '90 days'`),
      recommendations: await q(`DELETE FROM daily_recommendations WHERE rec_date < CURRENT_DATE - 7`),
      notifications: await q(`DELETE FROM notifications WHERE created_at < NOW() - INTERVAL '90 days'`),
      randomSkips: await q(`DELETE FROM random_skips WHERE created_at < NOW() - INTERVAL '2 days'`),
    };
  },

  async refreshAges() {
    const r = await query(`UPDATE users SET age = mf_age(dob, age) WHERE dob IS NOT NULL AND age IS DISTINCT FROM mf_age(dob, age)`);
    return r.rowCount;
  },

  async generateDailyRecommendations(limit = 500) {
    const users = await many(`SELECT u.* FROM users u WHERE u.is_demo=false AND u.status='active' AND u.discoverable=true AND u.verification_status='verified'
        AND u.last_active_at > NOW() - INTERVAL '7 days'
        AND NOT EXISTS (SELECT 1 FROM daily_recommendations d WHERE d.user_id=u.id AND d.rec_date = (NOW() AT TIME ZONE $2)::date)
        ORDER BY u.last_active_at DESC LIMIT $1`, [limit, cfg.DAY_TZ]);
    let n = 0; for (const u of users) { try { await discovery.generateRecommendationBatch(u); n++; } catch (e) { /* skip user */ } }
    return n;
  },
};

async function withLock(key, fn) {
  const c = await pool.connect();
  try {
    const { rows } = await c.query('SELECT pg_try_advisory_lock($1) AS ok', [key]);
    if (!rows[0].ok) return null;
    try { return await fn(); } finally { await c.query('SELECT pg_advisory_unlock($1)', [key]); }
  } finally { c.release(); }
}

async function runGroup(names, key) {
  return withLock(key, async () => {
    const out = {};
    for (const n of names) { try { out[n] = await tasks[n](); } catch (e) { logger.error({ err: e.message, job: n }, 'job failed'); out[n] = { error: e.message }; } }
    return out;
  });
}

const FREQUENT = ['sweepExpiredPlans', 'reactivateSuspensions', 'unhideReturning'];
const HOURLY = ['purgePendingDeletions', 'purgeOldContent'];
const DAILY = ['inactiveCleanup', 'cleanupTokens', 'refreshAges', 'generateDailyRecommendations'];

const timers = [];
function start() {
  if (process.env.DISABLE_JOBS === 'true') return;
  const every = (ms, names, key) => { const t = setInterval(() => runGroup(names, key).catch(() => {}), ms); t.unref?.(); timers.push(t); };
  every(10 * 60 * 1000, FREQUENT, 727301);
  every(60 * 60 * 1000, HOURLY, 727302);
  every(24 * 60 * 60 * 1000, DAILY, 727303);
  setTimeout(() => runGroup([...FREQUENT, ...DAILY], 727304).catch(() => {}), 30000).unref?.();
}
function stop() { timers.forEach(clearInterval); timers.length = 0; }

module.exports = { tasks, start, stop, runGroup };
