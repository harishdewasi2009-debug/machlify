const webpush = require('web-push');
const { one, many, query } = require('../db');
const { emitToUser, isOnline } = require('./realtime');
const logger = require('./logger');

let vapidReady = false;
function initVapid() {
  if (vapidReady) return true;
  const pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return false;
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:support@matchify.invalid', pub, priv);
  vapidReady = true; return true;
}

const ALWAYS = new Set(['safety', 'account', 'payment']);

// type: match | message | like | call | safety | account | payment | system
async function notify(userId, { type, title, body = '', data = {} }) {
  const u = await one('SELECT notification_prefs FROM users WHERE id=$1', [userId]);
  if (!u) return null;
  const prefs = u.notification_prefs || {};
  if (!ALWAYS.has(type) && prefs[type] === false) return null;
  const row = await one(
    `INSERT INTO notifications (user_id, type, title, body, data) VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`,
    [userId, type, title, body, JSON.stringify(data)]);
  emitToUser(userId, 'notification', { id: row.id, type, title, body, data, createdAt: row.created_at });
  if (!isOnline(userId) && initVapid()) pushTo(userId, { title, body, data: { ...data, type } }).catch(() => {});
  return row;
}

async function pushTo(userId, payload) {
  const subs = await many('SELECT * FROM push_subscriptions WHERE user_id=$1', [userId]);
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload));
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) await query('DELETE FROM push_subscriptions WHERE id=$1', [s.id]);
      else logger.warn({ err: e.message }, 'web push failed');
    }
  }
}

module.exports = { notify, pushTo, initVapid };
