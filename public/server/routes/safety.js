const express = require('express');
const { one, many, query } = require('../db');
const { requireAuth, requireAuthLenient } = require('../middleware/auth');
const limits = require('../middleware/limits');
const { HttpError, asyncHandler, parseJson, userAge } = require('../lib/util');
const { serializePublicProfile } = require('../lib/serialize');
const { recordSignal } = require('../lib/risk');
const { emitToUser } = require('../lib/realtime');

const router = express.Router();

const REASONS = { underage_suspected: 1, harassment: 1, inappropriate_messages: 2, inappropriate_photos: 2, spam_or_scam: 2, fake_profile: 3, other: 3 };

router.post('/block/:id', requireAuth, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || id === req.userId) throw new HttpError(400, 'Invalid user');
  if (!(await one('SELECT 1 FROM users WHERE id=$1', [id]))) throw new HttpError(404, 'User not found');
  await query('INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.userId, id]);
  // Close (do NOT delete) matches so messages remain available as report evidence.
  const closed = await many(
    `UPDATE matches SET status='closed', closed_by=$1, closed_reason='block', closed_at=NOW()
      WHERE status='active' AND ((user_a=$1 AND user_b=$2) OR (user_a=$2 AND user_b=$1)) RETURNING id`, [req.userId, id]);
  closed.forEach((m) => emitToUser(id, 'match:closed', { matchId: m.id }));
  require('../services/randomTalk').endSessionsBetween(req.userId, id, 'blocked').catch(() => {});
  res.json({ ok: true });
}));

router.delete('/block/:id', requireAuth, asyncHandler(async (req, res) => {
  await query('DELETE FROM blocks WHERE blocker_id=$1 AND blocked_id=$2', [req.userId, parseInt(req.params.id, 10)]);
  res.json({ ok: true });
}));

router.get('/blocked', requireAuth, asyncHandler(async (req, res) => {
  const rows = await many(`SELECT u.* FROM blocks b JOIN users u ON u.id=b.blocked_id WHERE b.blocker_id=$1 ORDER BY b.created_at DESC`, [req.userId]);
  res.json({ blocked: rows.map((u) => ({ id: u.id, name: u.name })) });
}));

async function snapshotProfile(u) {
  if (!u) return null;
  return { id: u.id, name: u.name, age: userAge(u), gender: u.gender, bio: u.bio, job: u.job, location: u.location, country: u.country,
           photos: parseJson(u.photos, []), verified: !!u.photo_verified, plan: u.plan, riskLevel: u.risk_level, createdAt: u.created_at };
}

router.post('/report', requireAuth, limits.reports, asyncHandler(async (req, res) => {
  const { userId, reason, details, matchId, sessionId, messageId } = req.body || {};
  const rid = parseInt(userId, 10);
  if (!rid || rid === req.userId) throw new HttpError(400, 'A valid userId is required');
  if (!REASONS[reason]) throw new HttpError(400, 'Unknown report reason');
  const reported = await one('SELECT * FROM users WHERE id=$1', [rid]);
  if (!reported) throw new HttpError(404, 'User not found');

  const dup = await one(`SELECT id FROM reports WHERE reporter_id=$1 AND reported_id=$2 AND status IN ('open','in_review') AND created_at > NOW() - INTERVAL '24 hours'`, [req.userId, rid]);
  if (dup) return res.json({ ok: true, id: dup.id, duplicate: true });

  let evidence = { profile: await snapshotProfile(reported) }; let context = 'profile'; let mid = null; let sid = null;
  if (matchId) {
    const m = await one('SELECT * FROM matches WHERE id=$1 AND (user_a=$2 OR user_b=$2) AND (user_a=$3 OR user_b=$3)', [matchId, req.userId, rid]);
    if (m) {
      mid = m.id; context = 'chat';
      evidence.messages = (await many(`SELECT id, sender_id, text, type, moderation_flag, created_at FROM messages WHERE match_id=$1 ORDER BY id DESC LIMIT 50`, [m.id])).reverse();
    }
  }
  if (sessionId) {
    const s = await one('SELECT * FROM random_sessions WHERE id=$1 AND (user_a=$2 OR user_b=$2) AND (user_a=$3 OR user_b=$3)', [sessionId, req.userId, rid]);
    if (s) {
      sid = s.id; context = 'random_talk';
      evidence.messages = (await many(`SELECT id, sender_id, text, moderation_flag, created_at FROM random_messages WHERE session_id=$1 ORDER BY id DESC LIMIT 50`, [s.id])).reverse();
      await query(`UPDATE random_sessions SET status=CASE WHEN status='active' THEN 'reported' ELSE status END, ended_at=COALESCE(ended_at, NOW()) WHERE id=$1`, [s.id]);
      require('../services/randomTalk').endSessionsBetween(req.userId, rid, 'reported').catch(() => {});
    }
  }
  const row = await one(
    `INSERT INTO reports (reporter_id, reported_id, reason, details, match_id, message_id, status, source, context, priority, evidence, session_id, reported_snapshot)
     VALUES ($1,$2,$3,$4,$5,$6,'open','user',$7,$8,$9,$10,$11) RETURNING id`,
    [req.userId, rid, reason, String(details || '').slice(0, 1000), mid, messageId || null, context, REASONS[reason], JSON.stringify(evidence), sid, JSON.stringify(evidence.profile)]);

  const n = await one(`SELECT COUNT(DISTINCT reporter_id) c FROM reports WHERE reported_id=$1 AND created_at > NOW() - INTERVAL '7 days' AND reporter_id IS NOT NULL`, [rid]);
  if (Number(n.c) >= 3) await recordSignal(rid, 'report_rate', { distinctReporters: Number(n.c) }, { dedupeMinutes: 24 * 60 });
  res.status(201).json({ ok: true, id: row.id });
}));

// Own enforcement status + appeal (suspended/banned users can still reach these).
router.get('/status', requireAuthLenient, asyncHandler(async (req, res) => {
  const action = await one(`SELECT id, action, reason, expires_at, created_at FROM moderation_actions WHERE user_id=$1 AND reversed_at IS NULL ORDER BY created_at DESC LIMIT 1`, [req.userId]);
  const appeal = await one(`SELECT id, status, resolution_note, created_at FROM appeals WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`, [req.userId]);
  res.json({ status: req.user.status, statusReason: req.user.status_reason, suspendedUntil: req.user.suspended_until, latestAction: action, latestAppeal: appeal });
}));

router.post('/appeals', requireAuthLenient, limits.reports, asyncHandler(async (req, res) => {
  const message = String(req.body?.message || '').trim();
  if (message.length < 10 || message.length > 2000) throw new HttpError(400, 'Please explain your appeal in 10–2000 characters.');
  if (await one(`SELECT 1 FROM appeals WHERE user_id=$1 AND status='open'`, [req.userId])) throw new HttpError(409, 'You already have an open appeal.');
  const act = await one(`SELECT id FROM moderation_actions WHERE user_id=$1 AND reversed_at IS NULL ORDER BY created_at DESC LIMIT 1`, [req.userId]);
  const a = await one(`INSERT INTO appeals (user_id, action_id, message) VALUES ($1,$2,$3) RETURNING id`, [req.userId, act?.id || null, message]);
  res.status(201).json({ ok: true, id: a.id });
}));

module.exports = router;
module.exports.router = router;
