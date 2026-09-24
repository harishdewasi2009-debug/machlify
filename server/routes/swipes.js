const express = require('express');
const { one, many, query, tx } = require('../db');
const cfg = require('../config');
const { requireAuth, requireVerified } = require('../middleware/auth');
const { requireProfile } = require('./users');
const { HttpError, asyncHandler } = require('../lib/util');
const { buildEligibility } = require('../lib/visibility');
const { ent, can } = require('../lib/entitlements');
const { serializePublicProfile } = require('../lib/serialize');
const { recordSignal } = require('../lib/risk');
const { notify } = require('../lib/notify');
const { emitToUser } = require('../lib/realtime');

const router = express.Router();
const TZ = cfg.DAY_TZ;
const DAY_START = `(date_trunc('day', NOW() AT TIME ZONE $2) AT TIME ZONE $2)`;

async function usedToday(client, userId, actions) {
  const r = await client.query(
    `SELECT COUNT(*)::int c FROM swipe_events WHERE user_id=$1 AND action = ANY($3::text[]) AND created_at >= ${DAY_START}`, [userId, TZ, actions]);
  return r.rows[0].c;
}

router.get('/quota', requireAuth, requireVerified, asyncHandler(async (req, res) => {
  const e = ent(req.user);
  const likes = await one(`SELECT COUNT(*)::int c FROM swipe_events WHERE user_id=$1 AND action='like' AND created_at >= ${DAY_START}`, [req.userId, TZ]);
  const supers = await one(`SELECT COUNT(*)::int c FROM swipe_events WHERE user_id=$1 AND action='superlike' AND created_at >= ${DAY_START}`, [req.userId, TZ]);
  res.json({ likes: { used: likes.c, limit: e.likesPerDay }, superlikes: { used: supers.c, limit: e.superlikesPerDay }, rewind: e.rewind });
}));

router.post('/', requireAuth, requireVerified, requireProfile, asyncHandler(async (req, res) => {
  const { targetId, action } = req.body || {};
  const tid = parseInt(targetId, 10);
  if (!tid || !['like', 'pass', 'superlike'].includes(action)) throw new HttpError(400, 'targetId and action (like|pass|superlike) are required');
  if (tid === req.userId) throw new HttpError(400, 'You cannot swipe on yourself');
  const viewer = req.user;

  const result = await tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock($1)', [viewer.id]);      // serialise per-user so caps cannot be raced
    // Target must be someone this user is allowed to see (no blocks, adult, verified, active, demo isolation).
    const params = [];
    const { conds } = buildEligibility(viewer, { params, mutualPrefs: false, excludeSwiped: false, excludeMatched: false });
    params.push(tid);
    const t = (await c.query(`SELECT u.* FROM users u WHERE ${conds.join(' AND ')} AND u.id = $${params.length}`, params)).rows[0];
    if (!t) throw new HttpError(404, 'That profile is not available', { code: 'target_unavailable' });
    if ((await c.query('SELECT 1 FROM swipes WHERE swiper_id=$1 AND target_id=$2', [viewer.id, tid])).rowCount) throw new HttpError(409, 'You already swiped on this profile', { code: 'already_swiped' });

    const e = ent(viewer);
    if (action === 'like' && e.likesPerDay != null) {
      const used = await usedToday(c, viewer.id, ['like']);
      if (used >= e.likesPerDay) throw new HttpError(429, 'You have used all your likes for today.', { code: 'like_limit_reached', limit: e.likesPerDay, upgrade: true });
    }
    if (action === 'superlike') {
      const used = await usedToday(c, viewer.id, ['superlike']);
      if (used >= e.superlikesPerDay) throw new HttpError(429, 'You have used all your Super Likes for today.', { code: 'superlike_limit_reached', limit: e.superlikesPerDay, upgrade: true });
    }
    await c.query('INSERT INTO swipes (swiper_id, target_id, action) VALUES ($1,$2,$3)', [viewer.id, tid, action]);
    await c.query('INSERT INTO swipe_events (user_id, target_id, action) VALUES ($1,$2,$3)', [viewer.id, tid, action]);

    let match = null;
    if (action !== 'pass') {
      const back = (await c.query(`SELECT 1 FROM swipes WHERE swiper_id=$1 AND target_id=$2 AND action IN ('like','superlike')`, [tid, viewer.id])).rowCount;
      if (back) {
        const [a, b] = viewer.id < tid ? [viewer.id, tid] : [tid, viewer.id];
        match = (await c.query(`INSERT INTO matches (user_a, user_b, source) VALUES ($1,$2,'swipe')
                                ON CONFLICT (user_a, user_b) DO UPDATE SET user_a = EXCLUDED.user_a RETURNING *`, [a, b])).rows[0];
      }
    }
    return { target: t, match };
  });

  const { target, match } = result;
  if (match) {
    notify(target.id, { type: 'match', title: `It's a match with ${viewer.name}!`, body: 'Say hello 👋', data: { matchId: match.id } }).catch(() => {});
    emitToUser(target.id, 'match:new', { matchId: match.id });
  } else if (action !== 'pass') {
    notify(target.id, { type: 'like', title: action === 'superlike' ? 'Someone Super Liked you ⭐' : 'Someone liked you',
      body: 'Upgrade to Premium to see who.', data: {} }).catch(() => {});
  }
  // Abnormal swipe volume → risk signal (bots / spam).
  const rate = await one(`SELECT COUNT(*)::int c FROM swipe_events WHERE user_id=$1 AND created_at > NOW() - INTERVAL '1 hour'`, [viewer.id]);
  if (rate.c > 200) await recordSignal(viewer.id, 'high_swipe_rate', { perHour: rate.c });

  res.json({
    ok: true, action,
    match: match ? { id: match.id, createdAt: match.created_at, user: serializePublicProfile(target) } : null,
  });
}));

// Rewind (Plus and above): undo the last swipe within a few minutes, only if it did not create a match.
router.post('/rewind', requireAuth, requireVerified, asyncHandler(async (req, res) => {
  if (!can(req.user, 'rewind')) throw new HttpError(402, 'Rewind is available on Plus and above.', { code: 'upgrade_required', feature: 'rewind' });
  const last = await one(
    `SELECT s.* FROM swipes s WHERE s.swiper_id=$1 AND s.created_at > NOW() - ($2 || ' minutes')::interval
       AND NOT EXISTS (SELECT 1 FROM matches m WHERE (m.user_a=s.swiper_id AND m.user_b=s.target_id) OR (m.user_b=s.swiper_id AND m.user_a=s.target_id))
     ORDER BY s.created_at DESC, s.id DESC LIMIT 1`, [req.userId, String(cfg.REWIND_WINDOW_MINUTES)]);
  if (!last) throw new HttpError(404, 'Nothing to rewind (only your most recent swipe, within a few minutes, and never after a match).', { code: 'nothing_to_rewind' });
  await query('DELETE FROM swipes WHERE id=$1', [last.id]);
  res.json({ ok: true, rewound: { targetId: last.target_id, action: last.action } });
}));

module.exports = router;
module.exports.router = router;
