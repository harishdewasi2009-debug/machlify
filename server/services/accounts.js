// Account lifecycle: deletion scheduling, purge, export.
const { one, many, query, tx } = require('../db');
const cfg = require('../config');
const { sha256 } = require('../lib/util');
const storage = require('../lib/storage');
const tokens = require('./tokens');
const { disconnectUser } = require('../lib/realtime');
const { sendMail } = require('../lib/mailer');
const { audit } = require('../lib/audit');

async function scheduleDeletion(user) {
  await query(`UPDATE users SET status='pending_deletion', deletion_scheduled_at = NOW() + ($2 || ' days')::interval, discoverable=false WHERE id=$1`,
    [user.id, String(cfg.DELETION_GRACE_DAYS)]);
  await tokens.revokeAll(user.id);
  disconnectUser(user.id, 'pending_deletion');
  try { await require('./payments').cancelAllSubscriptions(user.id); } catch (e) { /* best effort */ }
  sendMail({ to: user.email, subject: `Your ${cfg.BRAND_NAME} account is scheduled for deletion`,
    text: `Your account will be permanently deleted in ${cfg.DELETION_GRACE_DAYS} days. Changed your mind? Log in before then and choose "Cancel deletion".` }).catch(() => {});
  await audit({ id: user.id, role: user.role }, 'account.delete_scheduled', 'user', user.id);
}

async function cancelDeletion(user) {
  if (user.status !== 'pending_deletion') return false;
  await query(`UPDATE users SET status='active', deletion_scheduled_at=NULL, discoverable=true WHERE id=$1`, [user.id]);
  await audit({ id: user.id, role: user.role }, 'account.delete_cancelled', 'user', user.id);
  return true;
}

// Hard delete: profile, photos (files too), messages, matches, everything cascades.
// Only a minimal, hashed safety record survives, for a disclosed retention period.
async function purgeUser(userId) {
  const u = await one('SELECT * FROM users WHERE id=$1', [userId]);
  if (!u) return false;
  const photos = await many('SELECT storage_key FROM photos WHERE user_id=$1', [userId]);
  const enforced = await one(`SELECT 1 FROM moderation_actions WHERE user_id=$1 AND action IN ('warn','restrict','suspend','ban') LIMIT 1`, [userId])
    || (u.status === 'banned' ? { x: 1 } : null);
  await tx(async (c) => {
    await c.query(`INSERT INTO deleted_account_records (email_hash, phone_hash, had_enforcement, reason, retain_until)
                   VALUES ($1,$2,$3,'user_deletion', NOW() + ($4 || ' days')::interval)`,
      [sha256(u.email.toLowerCase()), u.phone ? sha256(u.phone) : null, !!enforced, String(cfg.SAFETY_RECORD_RETENTION_DAYS)]);
    if (u.status === 'banned') {
      await c.query(`INSERT INTO banned_identities (kind, hash, reason) VALUES ('email',$1,'banned_account_deleted') ON CONFLICT DO NOTHING`, [sha256(u.email.toLowerCase())]);
      if (u.phone) await c.query(`INSERT INTO banned_identities (kind, hash, reason) VALUES ('phone',$1,'banned_account_deleted') ON CONFLICT DO NOTHING`, [sha256(u.phone)]);
    }
    await c.query('DELETE FROM users WHERE id=$1', [userId]);
  });
  for (const p of photos) { if (p.storage_key) { await storage.remove(p.storage_key); await storage.remove(p.storage_key.replace('.jpg', '_t.jpg')); } }
  await audit(null, 'account.purged', 'user', userId, {});
  return true;
}

async function exportData(user) {
  const [photos, prompts, matches, swipes, notifs, payments, logins] = await Promise.all([
    many('SELECT id, url, status, created_at FROM photos WHERE user_id=$1', [user.id]),
    many('SELECT prompt_key, answer FROM profile_prompts WHERE user_id=$1', [user.id]),
    many(`SELECT m.id, m.created_at, m.status, m.source, CASE WHEN m.user_a=$1 THEN m.user_b ELSE m.user_a END AS other_user_id FROM matches m WHERE m.user_a=$1 OR m.user_b=$1`, [user.id]),
    many('SELECT target_id, action, created_at FROM swipes WHERE swiper_id=$1', [user.id]),
    many('SELECT type, title, body, created_at FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 500', [user.id]),
    many('SELECT product_key, amount, currency, status, created_at FROM payments WHERE user_id=$1', [user.id]),
    many(`SELECT kind, ip, user_agent, created_at FROM login_events WHERE user_id=$1 ORDER BY created_at DESC LIMIT 200`, [user.id]),
  ]);
  for (const m of matches) {
    m.messages = await many('SELECT sender_id, text, type, created_at FROM messages WHERE match_id=$1 ORDER BY created_at', [m.id]);
  }
  const { password_hash, staff_totp_secret, ...profile } = user;
  await query('INSERT INTO data_export_requests (user_id) VALUES ($1)', [user.id]);
  return { exportedAt: new Date().toISOString(), profile, photos, prompts, matches, swipes, notifications: notifs, payments, loginHistory: logins };
}

module.exports = { scheduleDeletion, cancelDeletion, purgeUser, exportData };
