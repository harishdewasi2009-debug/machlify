const express = require('express');
const { one, many, query } = require('../db');
const { requireAuth, requireVerified } = require('../middleware/auth');
const { HttpError, asyncHandler } = require('../lib/util');
const { serializePublicProfile } = require('../lib/serialize');
const chat = require('../services/chat');
const { emitToUser } = require('../lib/realtime');

const router = express.Router();

router.get('/', requireAuth, requireVerified, asyncHandler(async (req, res) => {
  const rows = await many(
    `SELECT m.id AS match_id, m.created_at AS matched_at, m.source, u.*,
            (SELECT row_to_json(x) FROM (SELECT id, sender_id, text, type, created_at FROM messages WHERE match_id = m.id ORDER BY id DESC LIMIT 1) x) AS last_message,
            (SELECT COUNT(*) FROM messages WHERE match_id = m.id AND sender_id <> $1 AND read_at IS NULL)::int AS unread
       FROM matches m JOIN users u ON u.id = CASE WHEN m.user_a = $1 THEN m.user_b ELSE m.user_a END
      WHERE (m.user_a = $1 OR m.user_b = $1) AND m.status = 'active' AND u.status IN ('active','restricted') AND u.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id=$1 AND b.blocked_id=u.id) OR (b.blocker_id=u.id AND b.blocked_id=$1))
      ORDER BY COALESCE((SELECT MAX(created_at) FROM messages WHERE match_id = m.id), m.created_at) DESC`, [req.userId]);
  res.json({
    matches: rows.map((r) => ({
      id: r.match_id, createdAt: r.matched_at, source: r.source,
      user: serializePublicProfile(r),
      lastMessage: r.last_message ? { text: r.last_message.text, createdAt: r.last_message.created_at, senderId: r.last_message.sender_id, type: r.last_message.type } : null,
      unreadCount: r.unread,
    })),
  });
}));

router.get('/:id/messages', requireAuth, requireVerified, asyncHandler(async (req, res) => {
  const { messages } = await chat.history(req.user, req.params.id, { before: req.query.before, limit: req.query.limit });
  await chat.markRead(req.user, req.params.id);
  res.json({ messages });
}));

router.post('/:id/messages', requireAuth, requireVerified, asyncHandler(async (req, res) => {
  const out = await chat.sendMessage(req.user, req.params.id, req.body?.text, { clientId: req.body?.clientId });
  res.status(201).json(out);
}));

router.post('/:id/read', requireAuth, requireVerified, asyncHandler(async (req, res) => {
  res.json({ marked: await chat.markRead(req.user, req.params.id) });
}));

// Unmatch = close (kept, hidden, evidence-preserving) — never a hard delete.
router.delete('/:id', requireAuth, requireVerified, asyncHandler(async (req, res) => {
  const { match, otherId } = await chat.getActiveMatch(req.params.id, req.userId);
  await query(`UPDATE matches SET status='closed', closed_by=$2, closed_reason='unmatch', closed_at=NOW() WHERE id=$1`, [match.id, req.userId]);
  emitToUser(otherId, 'match:closed', { matchId: match.id });
  res.json({ ok: true });
}));

// Persist a call record (callee is derived from the match — never trusted from the client).
router.post('/:id/calls', requireAuth, requireVerified, asyncHandler(async (req, res) => {
  const { match, otherId } = await chat.getActiveMatch(req.params.id, req.userId);
  const { callType, status, durationSeconds } = req.body || {};
  if (!['audio', 'video'].includes(callType)) throw new HttpError(400, 'callType must be audio or video');
  const st = ['completed', 'missed', 'rejected'].includes(status) ? status : 'missed';
  const dur = Math.min(Math.max(parseInt(durationSeconds, 10) || 0, 0), 6 * 3600);
  await query(`INSERT INTO calls (match_id, caller_id, callee_id, call_type, status, ended_at, duration_seconds) VALUES ($1,$2,$3,$4,$5,NOW(),$6)`,
    [match.id, req.userId, otherId, callType, st, dur]);
  const text = st === 'completed'
    ? `${callType === 'video' ? 'Video' : 'Voice'} call · ${Math.floor(dur / 60)}m ${dur % 60}s`
    : `Missed ${callType === 'video' ? 'video' : 'voice'} call`;
  await query(`INSERT INTO messages (match_id, sender_id, text, type, delivered_at) VALUES ($1,$2,$3,'call', NOW())`, [match.id, req.userId, text]);
  res.status(201).json({ ok: true });
}));

module.exports = router;
module.exports.router = router;
