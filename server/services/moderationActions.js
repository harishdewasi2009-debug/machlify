const { one, many, query } = require('../db');
const cfg = require('../config');
const { HttpError, sha256 } = require('../lib/util');
const { audit } = require('../lib/audit');
const { notify } = require('../lib/notify');
const { sendMail } = require('../lib/mailer');
const { disconnectUser } = require('../lib/realtime');
const tokens = require('./tokens');
const storage = require('../lib/storage');
const { refreshProfile } = require('./profile');

const MOD_ACTIONS = ['warn', 'restrict', 'unrestrict', 'suspend', 'unsuspend', 'force_reverify', 'remove_photos'];
const ADMIN_ACTIONS = ['ban', 'unban'];

async function applyAction({ actor, userId, action, reason, days, reportId, ip }) {
  if (![...MOD_ACTIONS, ...ADMIN_ACTIONS].includes(action)) throw new HttpError(400, 'Unknown action');
  if (ADMIN_ACTIONS.includes(action) && actor.role !== 'admin') throw new HttpError(403, 'Only admins can ban or unban.', { code: 'forbidden' });
  const target = await one('SELECT * FROM users WHERE id=$1', [userId]);
  if (!target) throw new HttpError(404, 'User not found');
  if (target.id === actor.id) throw new HttpError(400, 'You cannot moderate yourself.');
  if (['moderator', 'admin'].includes(target.role) && actor.role !== 'admin') throw new HttpError(403, 'Only admins can act on staff accounts.', { code: 'forbidden' });
  if (!reason || String(reason).trim().length < 3) throw new HttpError(400, 'A reason is required.');
  reason = String(reason).trim().slice(0, 500);

  let expiresAt = null;
  switch (action) {
    case 'warn':
      await notify(userId, { type: 'safety', title: 'Community guidelines warning', body: reason });
      sendMail({ to: target.email, subject: `Warning about your ${cfg.BRAND_NAME} account`, text: `We reviewed a report about your account.\n\n${reason}\n\nRepeated violations may lead to suspension.` }).catch(() => {});
      break;
    case 'restrict':
      await query(`UPDATE users SET status='restricted', status_reason=$2 WHERE id=$1`, [userId, reason]);
      break;
    case 'unrestrict':
      await query(`UPDATE users SET status='active', status_reason=NULL WHERE id=$1 AND status='restricted'`, [userId]);
      break;
    case 'suspend': {
      const max = actor.role === 'admin' ? 365 : 30;
      const d = parseInt(days, 10);
      if (!d || d < 1 || d > max) throw new HttpError(400, `days must be between 1 and ${max}`);
      expiresAt = new Date(Date.now() + d * 86400000);
      await query(`UPDATE users SET status='suspended', status_reason=$2, suspended_until=$3, is_online=false WHERE id=$1`, [userId, reason, expiresAt]);
      await tokens.revokeAll(userId); disconnectUser(userId, 'suspended');
      sendMail({ to: target.email, subject: `Your ${cfg.BRAND_NAME} account is suspended`, text: `Your account is suspended until ${expiresAt.toDateString()}.\n\nReason: ${reason}\n\nYou can appeal from the login screen.` }).catch(() => {});
      break;
    }
    case 'unsuspend':
      await query(`UPDATE users SET status='active', status_reason=NULL, suspended_until=NULL WHERE id=$1 AND status='suspended'`, [userId]);
      break;
    case 'ban':
      await query(`UPDATE users SET status='banned', status_reason=$2, is_online=false, discoverable=false WHERE id=$1`, [userId, reason]);
      await query(`INSERT INTO banned_identities (kind, hash, reason) VALUES ('email',$1,$2) ON CONFLICT DO NOTHING`, [sha256(target.email.toLowerCase()), reason]);
      if (target.phone) await query(`INSERT INTO banned_identities (kind, hash, reason) VALUES ('phone',$1,$2) ON CONFLICT DO NOTHING`, [sha256(target.phone), reason]);
      if (target.google_id) await query(`INSERT INTO banned_identities (kind, hash, reason) VALUES ('google',$1,$2) ON CONFLICT DO NOTHING`, [sha256(target.google_id), reason]);
      await tokens.revokeAll(userId); disconnectUser(userId, 'banned');
      try { await require('./payments').cancelAllSubscriptions(userId); } catch (e) { /* best effort */ }
      sendMail({ to: target.email, subject: `Your ${cfg.BRAND_NAME} account has been banned`, text: `Your account was banned for violating our Community Guidelines.\n\nReason: ${reason}\n\nYou may appeal by replying to this email or from the login screen.` }).catch(() => {});
      break;
    case 'unban':
      await query(`UPDATE users SET status='active', status_reason=NULL, discoverable=true WHERE id=$1 AND status='banned'`, [userId]);
      await query(`DELETE FROM banned_identities WHERE kind='email' AND hash=$1`, [sha256(target.email.toLowerCase())]);
      break;
    case 'force_reverify':
      await query(`UPDATE users SET verification_status='unverified', photo_verified=false, over_18=false, verification_rejection_reason=NULL WHERE id=$1`, [userId]);
      await notify(userId, { type: 'safety', title: 'Please verify again', body: 'A moderator asked you to re-verify your identity to keep using Matchify.' });
      break;
    case 'remove_photos': {
      const photos = await many('SELECT storage_key FROM photos WHERE user_id=$1', [userId]);
      await query('DELETE FROM photos WHERE user_id=$1', [userId]);
      for (const p of photos) { if (p.storage_key) { await storage.remove(p.storage_key); await storage.remove(p.storage_key.replace('.jpg', '_t.jpg')); } }
      await refreshProfile(userId);
      await notify(userId, { type: 'safety', title: 'Your photos were removed', body: reason });
      break;
    }
  }
  const row = await one(`INSERT INTO moderation_actions (user_id, actor_id, action, reason, report_id, expires_at, previous_status) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [userId, actor.id, action, reason, reportId || null, expiresAt, target.status]);
  if (reportId) await query(`UPDATE reports SET status='actioned', resolution=$2, resolved_by=$3, resolved_at=NOW(), updated_at=NOW() WHERE id=$1`, [reportId, action, actor.id]);
  await audit(actor, `moderation.${action}`, 'user', userId, { reason, days: days || null, reportId: reportId || null }, ip);
  return row;
}

module.exports = { applyAction, MOD_ACTIONS, ADMIN_ACTIONS };
