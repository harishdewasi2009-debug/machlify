const express = require('express');
const bcrypt = require('bcryptjs');
const { one, many, query } = require('../db');
const cfg = require('../config');
const { requireAuth, requireAuthLenient, requireVerified } = require('../middleware/auth');
const { HttpError, asyncHandler, parseDob, ageFromDob, normalizeGender, normalizeInterests, interestTags, coarse, validLatLng,
        parseJson, userAge } = require('../lib/util');
const { serializeSelf, serializePublicProfile } = require('../lib/serialize');
const { ent, can, planOf } = require('../lib/entitlements');
const { moderateText } = require('../lib/moderation');
const { CITIES } = require('../lib/cities');
const discovery = require('../services/discovery');
const { refreshProfile, loadSelfExtras, loadPrompts } = require('../services/profile');
const { selfPayload } = require('./auth');
const accounts = require('../services/accounts');
const { verifyGoogleToken } = require('../lib/googleAuth');
const { audit } = require('../lib/audit');

const router = express.Router();

const profileComplete = (user) => parseJson(user.photos, []).length >= cfg.MIN_PROFILE_PHOTOS;
const requireProfile = (req, res, next) => (profileComplete(req.user)
  ? next()
  : next(new HttpError(403, `Add at least ${cfg.MIN_PROFILE_PHOTOS} approved photos to start discovering people.`, { code: 'profile_incomplete', need: 'photos' })));

// ---------- me ----------
router.get('/me', requireAuth, asyncHandler(async (req, res) => res.json({ user: await selfPayload(req.user) })));

router.put('/me', requireAuth, asyncHandler(async (req, res) => {
  const b = req.body || {};
  const u = req.user;
  const sets = []; const vals = []; const add = (col, v) => { vals.push(v); sets.push(`${col}=$${vals.length + 1}`); };

  if (b.name !== undefined) { const n = String(b.name).trim(); if (!n) throw new HttpError(400, 'Name cannot be empty'); add('name', n.slice(0, 60)); }
  if (b.dob !== undefined) {
    if (u.verification_status === 'verified' && u.dob) throw new HttpError(400, 'Your date of birth is locked after verification. Contact support to correct it.', { code: 'dob_locked' });
    const d = parseDob(b.dob); if (!d) throw new HttpError(400, 'Date of birth must be YYYY-MM-DD');
    const a = ageFromDob(d);
    if (a < cfg.MIN_AGE) throw new HttpError(400, `You must be at least ${cfg.MIN_AGE}.`, { code: 'underage' });
    if (a > cfg.MAX_AGE) throw new HttpError(400, 'Please enter a valid date of birth.');
    add('dob', d); add('age', a);
  }
  if (b.gender !== undefined) add('gender', normalizeGender(b.gender));
  if (b.bio !== undefined) {
    const bio = String(b.bio).trim();
    if (bio.length > cfg.MAX_BIO_LENGTH) throw new HttpError(400, `Bio must be ${cfg.MAX_BIO_LENGTH} characters or fewer`);
    const m = moderateText(bio);
    if (m.action === 'block' || m.reasons.includes('phone_number') || m.reasons.includes('upi_id'))
      throw new HttpError(422, 'Your bio contains content or contact details that are not allowed. Please edit it.', { code: 'content_blocked', reasons: m.reasons });
    add('bio', bio);
  }
  if (b.job !== undefined) add('job', String(b.job).trim().slice(0, 80));
  if (b.location !== undefined) add('location', String(b.location).trim().slice(0, 80));
  if (b.country !== undefined) add('country', String(b.country).trim().slice(0, 60));
  if (b.interests !== undefined) {
    const list = normalizeInterests(b.interests, cfg.MAX_INTERESTS);
    add('interests', JSON.stringify(list)); add('interest_tags', list.map((s) => s.toLowerCase()));
  }
  if (b.relationshipIntent !== undefined) {
    if (b.relationshipIntent && !cfg.INTENTS.includes(b.relationshipIntent)) throw new HttpError(400, 'Invalid relationship intent');
    add('relationship_intent', b.relationshipIntent || null);
  }
  if (b.heightCm !== undefined) { const h = b.heightCm === null || b.heightCm === '' ? null : parseInt(b.heightCm, 10); if (h !== null && (h < 120 || h > 230)) throw new HttpError(400, 'Height must be between 120 and 230 cm'); add('height_cm', h); }
  if (b.language !== undefined) add('language', String(b.language).slice(0, 8));
  // dating preferences
  if (b.prefGenders !== undefined) {
    const arr = (Array.isArray(b.prefGenders) ? b.prefGenders : []).map(normalizeGender).filter(Boolean);
    add('pref_genders', [...new Set(arr)]);
    add('interested_in', arr.length === 1 ? (arr[0] === 'woman' ? 'women' : arr[0] === 'man' ? 'men' : 'everyone') : 'everyone');
  }
  if (b.prefAgeMin !== undefined || b.prefAgeMax !== undefined) {
    const mn = Math.max(18, parseInt(b.prefAgeMin ?? u.pref_age_min, 10) || 18);
    const mx = Math.min(100, parseInt(b.prefAgeMax ?? u.pref_age_max, 10) || 100);
    if (mn > mx) throw new HttpError(400, 'Minimum age preference cannot exceed maximum');
    add('pref_age_min', mn); add('pref_age_max', mx);
  }
  if (b.prefDistanceKm !== undefined) add('pref_distance_km', Math.min(20000, Math.max(1, parseInt(b.prefDistanceKm, 10) || 100)));

  if (sets.length) await query(`UPDATE users SET ${sets.join(', ')} WHERE id=$1`, [u.id, ...vals]);

  if (b.prompts !== undefined) {
    if (!Array.isArray(b.prompts) || b.prompts.length > cfg.MAX_PROMPTS) throw new HttpError(400, `You can add at most ${cfg.MAX_PROMPTS} prompts`);
    const clean = [];
    for (const p of b.prompts) {
      if (!cfg.PROMPT_KEYS.includes(p.key)) throw new HttpError(400, 'Unknown prompt');
      const a = String(p.answer || '').trim();
      if (!a) continue;
      if (a.length > cfg.MAX_PROMPT_ANSWER) throw new HttpError(400, `Prompt answers must be ${cfg.MAX_PROMPT_ANSWER} characters or fewer`);
      const m = moderateText(a);
      if (m.action === 'block' || m.reasons.includes('phone_number')) throw new HttpError(422, 'A prompt answer contains content that is not allowed.', { code: 'content_blocked' });
      if (clean.some((c) => c.key === p.key)) continue;
      clean.push({ key: p.key, answer: a });
    }
    await query('DELETE FROM profile_prompts WHERE user_id=$1', [u.id]);
    for (let i = 0; i < clean.length; i++) await query('INSERT INTO profile_prompts (user_id, prompt_key, answer, position) VALUES ($1,$2,$3,$4)', [u.id, clean[i].key, clean[i].answer, i]);
  }
  await refreshProfile(u.id);
  res.json({ user: await selfPayload(await one('SELECT * FROM users WHERE id=$1', [u.id])) });
}));

// City preset or browser coordinates (coarsened to ~1 km before storing).
router.put('/me/location', requireAuth, asyncHandler(async (req, res) => {
  const { lat, lng, city, country } = req.body || {};
  let la, ln, name = city, ctry = country;
  if (lat !== undefined && lng !== undefined) {
    if (!validLatLng(lat, lng)) throw new HttpError(400, 'Invalid coordinates');
    la = coarse(lat); ln = coarse(lng);
  } else if (city) {
    const c = CITIES.find((x) => x.name.toLowerCase() === String(city).toLowerCase());
    if (!c) throw new HttpError(400, 'Unknown city — send lat/lng instead.');
    la = coarse(c.lat); ln = coarse(c.lng); name = c.name; ctry = ctry || 'India';
  } else throw new HttpError(400, 'Send lat & lng, or a city name.');
  await query(`UPDATE users SET lat=$2, lng=$3, location=COALESCE(NULLIF($4,''), location), country=COALESCE(NULLIF($5,''), country) WHERE id=$1`,
    [req.userId, la, ln, name ? String(name).slice(0, 80) : '', ctry ? String(ctry).slice(0, 60) : '']);
  await refreshProfile(req.userId);
  res.json({ user: await selfPayload(await one('SELECT * FROM users WHERE id=$1', [req.userId])) });
}));
router.get('/cities', (req, res) => res.json({ cities: CITIES.map((c) => ({ name: c.name, state: c.state })) }));

router.put('/me/settings', requireAuth, asyncHandler(async (req, res) => {
  const b = req.body || {}; const sets = []; const vals = [];
  const add = (c, v) => { vals.push(v); sets.push(`${c}=$${vals.length + 1}`); };
  for (const [k, col] of [['showDistance', 'show_distance'], ['showOnline', 'show_online'], ['readReceipts', 'read_receipts'], ['discoverable', 'discoverable']]) {
    if (b[k] !== undefined) add(col, !!b[k]);
  }
  if (b.discoverable !== undefined) add('hidden_reason', b.discoverable ? null : 'paused');
  if (b.incognito !== undefined) {
    if (b.incognito && !can(req.user, 'incognito')) throw new HttpError(402, 'Incognito is a Pro feature.', { code: 'upgrade_required', feature: 'incognito' });
    add('incognito', !!b.incognito);
  }
  if (b.notificationPrefs && typeof b.notificationPrefs === 'object') {
    const prefs = { ...(req.user.notification_prefs || {}) };
    for (const t of ['match', 'message', 'like', 'call']) if (b.notificationPrefs[t] !== undefined) prefs[t] = !!b.notificationPrefs[t];
    add('notification_prefs', JSON.stringify(prefs));
  }
  if (sets.length) await query(`UPDATE users SET ${sets.join(', ')} WHERE id=$1`, [req.userId, ...vals]);
  res.json({ user: await selfPayload(await one('SELECT * FROM users WHERE id=$1', [req.userId])) });
}));

router.post('/me/random-rules', requireAuth, asyncHandler(async (req, res) => {
  await query('UPDATE users SET random_rules_accepted_at=NOW() WHERE id=$1', [req.userId]);
  res.json({ ok: true });
}));

// ---------- boosts ----------
router.post('/me/boost', requireAuth, requireVerified, asyncHandler(async (req, res) => {
  const u = req.user;
  const active = await one('SELECT * FROM boosts WHERE user_id=$1 AND ends_at > NOW()', [u.id]);
  if (active) throw new HttpError(409, 'You already have an active boost.', { endsAt: active.ends_at });
  const e = ent(u);
  const period = new Date().toISOString().slice(0, 7);
  let source = null;
  if (e.monthlyBoosts > 0 && u.free_boost_period !== period) {
    const r = await one(`UPDATE users SET free_boost_period=$2 WHERE id=$1 AND (free_boost_period IS DISTINCT FROM $2) RETURNING id`, [u.id, period]);
    if (r) source = 'monthly';
  }
  if (!source) {
    const r = await one('UPDATE users SET boost_credits = boost_credits - 1 WHERE id=$1 AND boost_credits > 0 RETURNING boost_credits', [u.id]);
    if (!r) throw new HttpError(402, 'No boosts available. Buy a boost to get more visibility.', { code: 'no_boost_credits' });
    source = 'credit';
  }
  const b = await one(`INSERT INTO boosts (user_id, source, ends_at) VALUES ($1,$2, NOW() + ($3 || ' minutes')::interval) RETURNING *`, [u.id, source, String(cfg.BOOST_MINUTES)]);
  res.json({ boost: { endsAt: b.ends_at, source } });
}));

// ---------- discovery ----------
function parseDiscoverQuery(q) {
  const out = { ...q };
  if (q.interests) out.interests = String(q.interests).split(',').map((s) => s.trim()).filter(Boolean);
  for (const k of ['verifiedOnly', 'activeOnly', 'hasBio', 'hasPrompts']) if (q[k] !== undefined) out[k] = q[k] === 'true' || q[k] === '1';
  return out;
}

router.get('/discover', requireAuth, requireVerified, requireProfile, asyncHandler(async (req, res) => {
  res.json(await discovery.discover(req.user, parseDiscoverQuery(req.query)));
}));

router.get('/likes-you', requireAuth, requireVerified, asyncHandler(async (req, res) => res.json(await discovery.likesYou(req.user))));

router.get('/recommendations', requireAuth, requireVerified, requireProfile, asyncHandler(async (req, res) => res.json(await discovery.todaysRecommendations(req.user))));
router.post('/recommendations/refresh', requireAuth, requireVerified, requireProfile, asyncHandler(async (req, res) => {
  const r = await discovery.generateRecommendationBatch(req.user);
  if (r.full) throw new HttpError(402, 'You have used all of today\'s recommendation batches.', { code: 'upgrade_required', feature: 'recommendationBatches' });
  res.json(await discovery.todaysRecommendations(req.user));
}));

router.get('/viewers', requireAuth, requireVerified, asyncHandler(async (req, res) => {
  const rows = await many(
    `SELECT DISTINCT ON (pv.viewer_id) pv.viewer_id, pv.created_at FROM profile_views pv JOIN users v ON v.id = pv.viewer_id
      WHERE pv.viewed_id=$1 AND pv.created_at > NOW() - INTERVAL '30 days' AND v.status='active'
        AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id=$1 AND b.blocked_id=pv.viewer_id) OR (b.blocker_id=pv.viewer_id AND b.blocked_id=$1))
      ORDER BY pv.viewer_id, pv.created_at DESC`, [req.userId]);
  if (!can(req.user, 'whoViewed')) return res.json({ count: rows.length, locked: true, viewers: [] });
  const users = rows.length ? await many('SELECT * FROM users WHERE id = ANY($1::int[])', [rows.map((r) => r.viewer_id)]) : [];
  res.json({ count: rows.length, locked: false, viewers: users.map((u) => serializePublicProfile(u)) });
}));

router.get('/me/analytics', requireAuth, asyncHandler(async (req, res) => {
  const id = req.userId;
  const [views, likes, matches, sent, strength] = await Promise.all([
    one(`SELECT COUNT(*) c FROM profile_views WHERE viewed_id=$1 AND created_at > NOW() - INTERVAL '7 days'`, [id]),
    one(`SELECT COUNT(*) c FROM swipes WHERE target_id=$1 AND action IN ('like','superlike') AND created_at > NOW() - INTERVAL '7 days'`, [id]),
    one(`SELECT COUNT(*) c FROM matches WHERE (user_a=$1 OR user_b=$1) AND created_at > NOW() - INTERVAL '30 days'`, [id]),
    one(`SELECT COUNT(*) c FROM swipe_events WHERE user_id=$1 AND created_at > NOW() - INTERVAL '7 days'`, [id]),
    one('SELECT profile_strength FROM users WHERE id=$1', [id]),
  ]);
  res.json({ last7Days: { profileViews: +views.c, likesReceived: +likes.c, swipesMade: +sent.c }, matchesLast30Days: +matches.c, profileStrength: strength.profile_strength });
}));

// ---------- account lifecycle ----------
router.post('/me/delete', requireAuthLenient, asyncHandler(async (req, res) => {
  const u = req.user;
  if (u.password_hash) {
    if (!(await bcrypt.compare(String(req.body?.password || ''), u.password_hash))) throw new HttpError(401, 'Password is incorrect — re-enter it to confirm deletion.');
  } else if (u.google_id) {
    let g; try { g = await verifyGoogleToken(req.body?.credential); } catch (e) { throw new HttpError(401, 'Confirm with Google to delete your account.'); }
    if (g.sub !== u.google_id) throw new HttpError(401, 'That Google account does not match.');
  } else throw new HttpError(401, 'Re-authentication required.');
  await accounts.scheduleDeletion(u);
  res.json({ ok: true, deletionScheduledInDays: cfg.DELETION_GRACE_DAYS });
}));
router.post('/me/delete/cancel', requireAuthLenient, asyncHandler(async (req, res) => {
  const ok = await accounts.cancelDeletion(req.user);
  res.json({ ok, user: await selfPayload(await one('SELECT * FROM users WHERE id=$1', [req.userId])) });
}));
router.get('/me/export', requireAuthLenient, asyncHandler(async (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="matchify-data-export.json"');
  res.json(await accounts.exportData(req.user));
}));

// ---------- removed endpoints (explicit, so old clients fail loudly) ----------
router.post('/subscribe', (req, res) => res.status(410).json({ error: 'Plans are only activated through verified payments. Use /api/payments/checkout.', code: 'gone' }));
router.post('/random-talk', (req, res) => res.status(410).json({ error: 'Random Talk is now an opt-in live queue (Socket.io: random:join).', code: 'gone' }));

// ---------- another user's profile ----------
router.get('/:id(\\d+)', requireAuth, requireVerified, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.userId) return res.json({ user: await selfPayload(req.user) });
  const t = await one(
    `SELECT u.*, mf_distance_km($2::float8, $3::float8, u.lat, u.lng) AS dist,
       EXISTS (SELECT 1 FROM matches m WHERE m.status='active' AND ((m.user_a=$1 AND m.user_b=u.id) OR (m.user_b=$1 AND m.user_a=u.id))) AS is_match
       FROM users u WHERE u.id=$4`, [req.userId, req.user.lat, req.user.lng, id]);
  const blocked = t && await one('SELECT 1 FROM blocks WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1)', [req.userId, id]);
  const visible = t && !blocked && t.deleted_at == null && ['active', 'restricted'].includes(t.status) && userAge(t) >= 18 && (!t.is_demo || cfg.demoVisible());
  if (!visible) throw new HttpError(404, 'User not found');
  if (t.status !== 'active' && !t.is_match) throw new HttpError(404, 'User not found');
  if (!can(req.user, 'incognito') || !req.user.incognito) {
    await query(`INSERT INTO profile_views (viewer_id, viewed_id) SELECT $1,$2 WHERE NOT EXISTS
                 (SELECT 1 FROM profile_views WHERE viewer_id=$1 AND viewed_id=$2 AND created_at > NOW() - INTERVAL '1 day')`, [req.userId, id]);
  }
  res.json({ user: serializePublicProfile(t, { prompts: await loadPrompts(id), distanceKm: t.dist }) });
}));

module.exports = { router, requireProfile, profileComplete };
