// The ONE place that decides who may appear to whom. Discovery, likes-you,
// recommendations, search and Random Talk all build on buildEligibility().
const { REQUIRE_AGE_VERIFICATION, demoVisible } = require('../config');
const { userAge } = require('./util');

function buildEligibility(viewer, opts = {}) {
  const a = opts.alias || 'u';
  const params = opts.params || [];
  const p = (v) => { params.push(v); return '$' + params.length; };
  const conds = [];
  const vid = p(viewer.id);

  conds.push(`${a}.id <> ${vid}`);
  conds.push(`${a}.status = 'active'`);
  conds.push(`${a}.deleted_at IS NULL`);
  conds.push(`${a}.discoverable = true`);
  if (REQUIRE_AGE_VERIFICATION()) conds.push(`${a}.verification_status = 'verified'`);
  conds.push(`mf_age(${a}.dob, ${a}.age) >= 18`);
  if (!demoVisible() || opts.excludeDemo) conds.push(`${a}.is_demo = false`);
  if (opts.requirePhoto !== false) {
    conds.push(`EXISTS (SELECT 1 FROM photos ph WHERE ph.user_id = ${a}.id AND ph.status = 'approved')`);
  }
  conds.push(`NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = ${vid} AND b.blocked_id = ${a}.id) OR (b.blocker_id = ${a}.id AND b.blocked_id = ${vid}))`);

  if (opts.mutualPrefs !== false) {
    const vAge = userAge(viewer);
    if (viewer.pref_genders && viewer.pref_genders.length) conds.push(`${a}.gender = ANY(${p(viewer.pref_genders)}::text[])`);
    if (viewer.gender) conds.push(`(cardinality(${a}.pref_genders) = 0 OR ${p(viewer.gender)} = ANY(${a}.pref_genders))`);
    else conds.push(`cardinality(${a}.pref_genders) = 0`);
    conds.push(`mf_age(${a}.dob, ${a}.age) BETWEEN ${p(viewer.pref_age_min || 18)} AND ${p(viewer.pref_age_max || 100)}`);
    if (vAge != null) conds.push(`${p(vAge)}::int BETWEEN ${a}.pref_age_min AND ${a}.pref_age_max`);
  }
  if (opts.excludeSwiped !== false) {
    conds.push(`NOT EXISTS (SELECT 1 FROM swipes s WHERE s.swiper_id = ${vid} AND s.target_id = ${a}.id)`);
  }
  // Never resurface people I already have a match (any status) with.
  if (opts.excludeMatched !== false) {
    conds.push(`NOT EXISTS (SELECT 1 FROM matches m WHERE (m.user_a = ${vid} AND m.user_b = ${a}.id) OR (m.user_b = ${vid} AND m.user_a = ${a}.id))`);
  }
  return { conds, params, p };
}

// Can two specific users interact (chat / call / random-talk pair)?
async function pairAllowed(db, aId, bId) {
  const r = await db.one(
    `SELECT
       (SELECT COUNT(*) FROM blocks WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1)) AS blocked,
       (SELECT status FROM users WHERE id=$1) AS sa, (SELECT status FROM users WHERE id=$2) AS sb`, [aId, bId]);
  return r && Number(r.blocked) === 0 && r.sa === 'active' && r.sb === 'active';
}

module.exports = { buildEligibility, pairAllowed };
