// Discovery + ranking engine. Every list of "people" goes through queryCandidates(),
// which starts from buildEligibility() (lib/visibility.js) so no path can bypass
// blocks / age / verification / demo isolation.
const { many, one } = require('../db');
const cfg = require('../config');
const { buildEligibility } = require('../lib/visibility');
const { HttpError, userAge, parseJson } = require('../lib/util');
const { ent, planOf } = require('../lib/entitlements');
const { serializePublicProfile } = require('../lib/serialize');

const MODES = ['for_you', 'nearby', 'city', 'country', 'global', 'new', 'verified', 'active', 'interests'];
const ADVANCED_KEYS = ['heightMin', 'heightMax', 'intent', 'interests', 'verifiedOnly', 'activeOnly', 'hasBio', 'hasPrompts'];

const num = (v, d = null) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const encodeCursor = (score, id) => Buffer.from(JSON.stringify([score, id])).toString('base64url');
function decodeCursor(c) {
  try { const [s, i] = JSON.parse(Buffer.from(String(c), 'base64url').toString()); if (Number.isFinite(+s) && Number.isInteger(i)) return [+s, i]; } catch (e) { /* ignore */ }
  return null;
}

function checkAdvanced(viewer, q) {
  const used = ADVANCED_KEYS.filter((k) => q[k] !== undefined && q[k] !== '' && q[k] !== false && !(Array.isArray(q[k]) && !q[k].length));
  if (used.length && !ent(viewer).advancedFilters) {
    throw new HttpError(402, 'Advanced filters are available on Plus and above.', { code: 'upgrade_required', feature: 'advancedFilters', filters: used });
  }
}

/**
 * Core query. opts: { mode, limit, cursor, ids, filters, mutualPrefs, excludeSwiped, likedMeOnly }
 * Returns rows with dist / compat / rank_score / liked_me / boosted attached.
 */
async function queryCandidates(viewer, opts = {}) {
  const w = cfg.RANKING;
  const params = [];
  const elig = buildEligibility(viewer, { params, mutualPrefs: opts.mutualPrefs, excludeSwiped: opts.excludeSwiped, excludeMatched: opts.excludeMatched });
  const conds = elig.conds; const p = elig.p;
  const f = opts.filters || {};
  const mode = opts.mode || 'for_you';

  const vlat = viewer.lat, vlng = viewer.lng;
  const pLat = p(vlat ?? null), pLng = p(vlng ?? null);
  const pTags = p(viewer.interest_tags || []);
  const pAge = p(userAge(viewer) ?? 28);
  const pPrefDist = p(num(f.distanceKm, viewer.pref_distance_km) || 100);
  const vid = '$1';

  // ---- mode constraints ----
  if (mode === 'nearby') {
    if (vlat == null) throw new HttpError(400, 'Set your location to see people nearby.', { code: 'location_required' });
    const km = num(f.distanceKm, viewer.pref_distance_km) || 100;
    const dLat = km / 111, dLng = km / (111 * Math.max(0.2, Math.cos(vlat * Math.PI / 180)));
    conds.push(`u.lat BETWEEN ${p(vlat - dLat)} AND ${p(vlat + dLat)} AND u.lng BETWEEN ${p(vlng - dLng)} AND ${p(vlng + dLng)}`);
    conds.push(`mf_distance_km(${pLat}, ${pLng}, u.lat, u.lng) <= ${p(km)}`);
  } else if (mode === 'city') {
    if (!viewer.location) throw new HttpError(400, 'Add your city to see people in your city.', { code: 'location_required' });
    conds.push(`LOWER(TRIM(split_part(u.location, ',', 1))) = LOWER(TRIM(split_part(${p(viewer.location)}, ',', 1)))`);
  } else if (mode === 'country') {
    if (!viewer.country) throw new HttpError(400, 'Add your country to see people in your country.', { code: 'location_required' });
    conds.push(`LOWER(u.country) = LOWER(${p(viewer.country)})`);
  } else if (mode === 'new') {
    conds.push(`u.created_at > NOW() - INTERVAL '${cfg.NEW_USER_DAYS} days'`);
  } else if (mode === 'verified') {
    conds.push('u.photo_verified = true');
  } else if (mode === 'active') {
    conds.push(`u.show_online = true AND u.last_active_at > NOW() - INTERVAL '24 hours'`);
  } else if (mode === 'interests') {
    conds.push(`u.interest_tags && ${pTags}::text[]`);
  } else if (mode !== 'for_you' && mode !== 'global') {
    throw new HttpError(400, `mode must be one of: ${MODES.join(', ')}`);
  }

  // ---- filters (basic: country/city/gender/age/distance/interest; advanced gated in checkAdvanced) ----
  if (f.country && mode !== 'country') conds.push(`LOWER(u.country) = LOWER(${p(String(f.country))})`);
  if (f.city) conds.push(`LOWER(TRIM(split_part(u.location, ',', 1))) = LOWER(${p(String(f.city))})`);
  if (f.gender === 'women') conds.push(`u.gender = 'woman'`);
  else if (f.gender === 'men') conds.push(`u.gender = 'man'`);
  else if (f.gender && cfg.GENDERS.includes(f.gender)) conds.push(`u.gender = ${p(f.gender)}`);
  if (num(f.ageMin) != null) conds.push(`mf_age(u.dob, u.age) >= ${p(Math.max(18, num(f.ageMin)))}`);
  if (num(f.ageMax) != null) conds.push(`mf_age(u.dob, u.age) <= ${p(Math.min(100, num(f.ageMax)))}`);
  if (num(f.distanceKm) != null && mode !== 'nearby' && vlat != null) conds.push(`(u.lat IS NULL OR mf_distance_km(${pLat}, ${pLng}, u.lat, u.lng) <= ${p(num(f.distanceKm))})`);
  if (f.interest) conds.push(`${p(String(f.interest).toLowerCase())} = ANY(u.interest_tags)`);
  // advanced
  if (num(f.heightMin) != null) conds.push(`u.height_cm >= ${p(num(f.heightMin))}`);
  if (num(f.heightMax) != null) conds.push(`u.height_cm <= ${p(num(f.heightMax))}`);
  if (f.intent) conds.push(`u.relationship_intent = ${p(String(f.intent))}`);
  if (Array.isArray(f.interests) && f.interests.length) conds.push(`u.interest_tags && ${p(f.interests.map((s) => String(s).toLowerCase()))}::text[]`);
  if (f.verifiedOnly) conds.push('u.photo_verified = true');
  if (f.activeOnly) conds.push(`u.show_online = true AND u.last_active_at > NOW() - INTERVAL '24 hours'`);
  if (f.hasBio) conds.push(`LENGTH(TRIM(COALESCE(u.bio,''))) >= 20`);
  if (f.hasPrompts) conds.push(`EXISTS (SELECT 1 FROM profile_prompts pp WHERE pp.user_id = u.id)`);
  if (opts.ids) conds.push(`u.id = ANY(${p(opts.ids)}::int[])`);
  if (opts.likedMeOnly) conds.push(`EXISTS (SELECT 1 FROM swipes lm WHERE lm.swiper_id = u.id AND lm.target_id = ${vid} AND lm.action IN ('like','superlike'))`);

  // ---- ranking (deterministic, explainable; no protected-attribute inference) ----
  const compat = `(100 * (
      ${w.interests} * LEAST(1.0, shared / GREATEST(1, LEAST(cardinality(interest_tags), cardinality(${pTags}::text[]))))
    + ${w.ageFit} * GREATEST(0, 1 - ABS(mf_age(dob, age) - ${pAge}) / 15.0)
    + ${w.distanceFit} * (CASE WHEN dist IS NULL THEN 0.4 ELSE GREATEST(0, 1 - dist / GREATEST(${pPrefDist}, 1)) END)
    + ${w.recency} * GREATEST(0, 1 - EXTRACT(EPOCH FROM (NOW() - last_active_at)) / (86400 * 14.0))
    + ${w.completeness} * (profile_strength / 100.0)
    + ${w.verified} * (CASE WHEN photo_verified THEN 1 ELSE 0 END)
    + ${w.likedMe} * (CASE WHEN liked_me THEN 1 ELSE 0 END)))`;

  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 20, 1), 50);
  let cursorSql = '';
  const cur = opts.cursor ? decodeCursor(opts.cursor) : null;
  if (opts.cursor && !cur) throw new HttpError(400, 'Invalid cursor');
  if (cur) cursorSql = `WHERE (rank_score, id) < (${p(cur[0])}::numeric, ${p(cur[1])}::int)`;
  const pLimit = p(limit + 1);

  const sql = `
    WITH cand AS (
      SELECT u.*,
        mf_distance_km(${pLat}, ${pLng}, u.lat, u.lng) AS dist,
        (SELECT COUNT(*) FROM unnest(u.interest_tags) t WHERE t = ANY(${pTags}::text[]))::float AS shared,
        EXISTS (SELECT 1 FROM swipes s2 WHERE s2.swiper_id = u.id AND s2.target_id = ${vid} AND s2.action IN ('like','superlike')) AS liked_me,
        EXISTS (SELECT 1 FROM boosts bo WHERE bo.user_id = u.id AND bo.ends_at > NOW()) AS boosted,
        (u.plan = 'pro' AND (u.plan_expires_at IS NULL OR u.plan_expires_at > NOW())) AS is_priority
      FROM users u WHERE ${conds.join(' AND ')}
    ), scored AS (
      SELECT cand.*, ROUND(${compat}::numeric, 2) AS compat FROM cand
    ), ranked AS (
      SELECT scored.*, (compat + CASE WHEN boosted THEN ${w.boostBonus} ELSE 0 END + CASE WHEN is_priority THEN ${w.priorityBonus} ELSE 0 END) AS rank_score FROM scored
    )
    SELECT * FROM ranked ${cursorSql} ORDER BY rank_score DESC, id DESC LIMIT ${pLimit}`;

  const rows = await many(sql, params);
  const hasMore = rows.length > limit;
  return { rows: rows.slice(0, limit), hasMore, limit };
}

async function attachPrompts(rows) {
  if (!rows.length) return new Map();
  const ps = await many(`SELECT user_id, prompt_key, answer FROM profile_prompts WHERE user_id = ANY($1::int[]) ORDER BY position, id`, [rows.map((r) => r.id)]);
  const map = new Map();
  for (const r of ps) { if (!map.has(r.user_id)) map.set(r.user_id, []); map.get(r.user_id).push({ key: r.prompt_key, answer: r.answer }); }
  return map;
}

async function serializeRows(viewer, rows) {
  const prompts = await attachPrompts(rows);
  const canSeeLikes = ent(viewer).seeLikes;
  return rows.map((r) => serializePublicProfile(r, {
    prompts: prompts.get(r.id) || [], distanceKm: r.dist, compat: Math.round(r.compat),
    likedYou: canSeeLikes && r.liked_me, boosted: r.boosted,
  }));
}

async function discover(viewer, q = {}) {
  const filters = { ...q };
  checkAdvanced(viewer, filters);
  const { rows, hasMore } = await queryCandidates(viewer, { mode: q.mode || 'for_you', limit: q.limit, cursor: q.cursor, filters });
  const last = rows[rows.length - 1];
  return {
    profiles: await serializeRows(viewer, rows),
    nextCursor: hasMore && last ? encodeCursor(last.rank_score, last.id) : null,
    mode: q.mode || 'for_you',
  };
}

// Users who liked me that I haven't swiped on.
async function likesYou(viewer, { limit = 50 } = {}) {
  const { rows } = await queryCandidates(viewer, { mode: 'global', limit, likedMeOnly: true, mutualPrefs: false });
  const entitled = ent(viewer).seeLikes;
  if (!entitled) return { count: rows.length, locked: true, profiles: [] };
  return { count: rows.length, locked: false, profiles: await serializeRows(viewer, rows) };
}

// Daily picks: persisted so they are stable through the day.
const todayExpr = `(NOW() AT TIME ZONE '${cfg.DAY_TZ.replace(/[^A-Za-z_/]/g, '')}')::date`;

async function generateRecommendationBatch(viewer) {
  const e = ent(viewer);
  const existing = await many(`SELECT rec_user_id FROM daily_recommendations WHERE user_id=$1 AND rec_date = ${todayExpr}`, [viewer.id]);
  const size = e.recommendationSize;
  if (existing.length >= size * e.recommendationBatches) return { added: 0, batches: Math.ceil(existing.length / size), full: true };
  const { rows } = await queryCandidates(viewer, { mode: 'for_you', limit: size + existing.length + 5 });
  const have = new Set(existing.map((r) => r.rec_user_id));
  const fresh = rows.filter((r) => !have.has(r.id)).slice(0, size);
  let rank = existing.length;
  for (const r of fresh) {
    await one(`INSERT INTO daily_recommendations (user_id, rec_user_id, rec_date, score, rank) VALUES ($1,$2,${todayExpr},$3,$4)
               ON CONFLICT DO NOTHING RETURNING id`, [viewer.id, r.id, Math.round(r.compat), rank++]);
  }
  return { added: fresh.length, batches: Math.ceil((existing.length + fresh.length) / size), full: false };
}

async function todaysRecommendations(viewer) {
  let recs = await many(`SELECT rec_user_id FROM daily_recommendations WHERE user_id=$1 AND rec_date = ${todayExpr} ORDER BY rank`, [viewer.id]);
  if (!recs.length) { await generateRecommendationBatch(viewer); recs = await many(`SELECT rec_user_id FROM daily_recommendations WHERE user_id=$1 AND rec_date = ${todayExpr} ORDER BY rank`, [viewer.id]); }
  const ids = recs.map((r) => r.rec_user_id);
  if (!ids.length) return { profiles: [], batches: 0, maxBatches: ent(viewer).recommendationBatches };
  // Re-apply eligibility at read time (blocks, swipes, suspensions since generation).
  const { rows } = await queryCandidates(viewer, { mode: 'global', ids, limit: 50 });
  const order = new Map(ids.map((id, i) => [id, i]));
  rows.sort((a, b) => order.get(a.id) - order.get(b.id));
  return { profiles: await serializeRows(viewer, rows), batches: Math.ceil(ids.length / ent(viewer).recommendationSize), maxBatches: ent(viewer).recommendationBatches };
}

// Same signals as the SQL ranker (minus "liked me", which is always true for a match), as a 0–100 score.
function computeCompatibility(viewer, other) {
  const w = cfg.RANKING;
  const vt = viewer.interest_tags || [], ot = other.interest_tags || [];
  const shared = ot.filter((t) => vt.includes(t)).length;
  const interests = Math.min(1, shared / Math.max(1, Math.min(vt.length, ot.length)));
  const ageFit = Math.max(0, 1 - Math.abs((userAge(viewer) ?? 28) - (userAge(other) ?? 28)) / 15);
  let dist = null;
  if (viewer.lat != null && viewer.lng != null && other.lat != null && other.lng != null) {
    const R = 6371, rad = (x) => x * Math.PI / 180;
    const dLat = rad(other.lat - viewer.lat), dLng = rad(other.lng - viewer.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(viewer.lat)) * Math.cos(rad(other.lat)) * Math.sin(dLng / 2) ** 2;
    dist = 2 * R * Math.asin(Math.sqrt(Math.min(1, h)));
  }
  const distFit = dist == null ? 0.4 : Math.max(0, 1 - dist / Math.max(viewer.pref_distance_km || 100, 1));
  const recency = Math.max(0, 1 - (Date.now() - new Date(other.last_active_at || Date.now()).getTime()) / (86400000 * 14));
  const sum = w.interests * interests + w.ageFit * ageFit + w.distanceFit * distFit + w.recency * recency +
              w.completeness * ((other.profile_strength || 0) / 100) + w.verified * (other.photo_verified ? 1 : 0);
  const score = Math.round((100 * sum) / (1 - w.likedMe));
  return { score: Math.max(1, Math.min(99, score)), shared: ot.filter((t) => vt.includes(t)), distanceKm: dist };
}

module.exports = { computeCompatibility, discover, likesYou, queryCandidates, serializeRows, generateRecommendationBatch, todaysRecommendations, MODES, ADVANCED_KEYS, planOf, parseJson };
