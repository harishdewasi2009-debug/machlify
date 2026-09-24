const { one, many, query } = require('../db');
const { PLAN_ENTITLEMENTS, PLAN_RANK } = require('../config');

function planOf(user) {
  const p = user.plan || 'free';
  if (p !== 'free' && user.plan_expires_at && new Date(user.plan_expires_at) < new Date()) return 'free';
  return PLAN_ENTITLEMENTS[p] ? p : 'free';
}
const ent = (user) => PLAN_ENTITLEMENTS[planOf(user)];
const can = (user, feature) => !!ent(user)[feature];
const limit = (user, key) => ent(user)[key];

// Recompute users.plan from active grants (the only way paid access is granted).
async function refreshUserPlan(userId) {
  const grants = await many(
    `SELECT plan, starts_at, ends_at FROM entitlement_grants
      WHERE user_id=$1 AND revoked_at IS NULL AND ends_at > NOW() ORDER BY starts_at`, [userId]);
  const now = Date.now();
  const active = grants.filter((g) => new Date(g.starts_at).getTime() <= now);
  let best = null;
  for (const g of active) if (!best || PLAN_RANK[g.plan] > PLAN_RANK[best]) best = g.plan;
  if (best) {
    // Chain back-to-back grants of the same plan (stacked packs / renewals) into one continuous window.
    let expires = Math.max(...active.filter((g) => g.plan === best).map((g) => new Date(g.ends_at).getTime()));
    for (const g of grants.filter((x) => x.plan === best)) {
      if (new Date(g.starts_at).getTime() <= expires + 5000) expires = Math.max(expires, new Date(g.ends_at).getTime());
    }
    await query(`UPDATE users SET plan=$2, premium=true, plan_expires_at=$3 WHERE id=$1`, [userId, best, new Date(expires)]);
  } else {
    await query(`UPDATE users SET plan='free', premium=false, plan_expires_at=NULL, billing_cycle=NULL, autopay=false WHERE id=$1`, [userId]);
  }
  return best || 'free';
}

module.exports = { planOf, ent, can, limit, refreshUserPlan };
