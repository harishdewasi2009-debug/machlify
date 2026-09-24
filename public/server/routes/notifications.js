const express = require('express');
const { one, many, query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { HttpError, asyncHandler } = require('../lib/util');

const router = express.Router();

router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const rows = await many(`SELECT id, type, title, body, data, read_at, created_at FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`, [req.userId]);
  const unread = await one('SELECT COUNT(*)::int c FROM notifications WHERE user_id=$1 AND read_at IS NULL', [req.userId]);
  res.json({ notifications: rows.map((n) => ({ id: n.id, type: n.type, title: n.title, text: n.title, body: n.body, data: n.data, read: !!n.read_at, createdAt: n.created_at })), unreadCount: unread.c });
}));

router.post('/read', requireAuth, asyncHandler(async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : null;
  if (ids) await query('UPDATE notifications SET read_at=NOW() WHERE user_id=$1 AND id = ANY($2::bigint[]) AND read_at IS NULL', [req.userId, ids]);
  else await query('UPDATE notifications SET read_at=NOW() WHERE user_id=$1 AND read_at IS NULL', [req.userId]);
  res.json({ ok: true });
}));

router.post('/push/subscribe', requireAuth, asyncHandler(async (req, res) => {
  const { endpoint, keys } = req.body || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) throw new HttpError(400, 'A valid push subscription is required');
  await query(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES ($1,$2,$3,$4)
               ON CONFLICT (endpoint) DO UPDATE SET user_id=EXCLUDED.user_id, p256dh=EXCLUDED.p256dh, auth=EXCLUDED.auth`, [req.userId, endpoint, keys.p256dh, keys.auth]);
  res.status(201).json({ ok: true });
}));
router.post('/push/unsubscribe', requireAuth, asyncHandler(async (req, res) => {
  await query('DELETE FROM push_subscriptions WHERE user_id=$1 AND endpoint=$2', [req.userId, req.body?.endpoint || '']);
  res.json({ ok: true });
}));

module.exports = router;
module.exports.router = router;
