const crypto = require('crypto');
const { one, query, many } = require('../../db');
const { VERIFICATION_PROVIDER, isProd } = require('../../config');
const { HttpError, ageFromDob, sha256 } = require('../../lib/util');
const { audit } = require('../../lib/audit');
const { recordSignal } = require('../../lib/risk');
const { notify } = require('../../lib/notify');
const { disconnectUser } = require('../../lib/realtime');

const PROVIDERS = {
  mock: () => require('./providers/mock'),
  generic: () => require('./providers/generic'),
  persona: () => require('./providers/persona'),
};

function getProvider() {
  const name = VERIFICATION_PROVIDER() || (isProd() ? '' : 'mock');
  if (!name || !PROVIDERS[name]) throw new HttpError(501, 'No identity-verification provider is configured on the server.', { code: 'no_provider' });
  if (name === 'mock' && isProd()) throw new HttpError(501, 'The mock provider is disabled in production.', { code: 'no_provider' });
  return PROVIDERS[name]();
}
const providerConfigured = () => { try { getProvider(); return true; } catch (e) { return false; } };

async function start(user, kind) {
  if (!['age_id', 'photo_selfie'].includes(kind)) throw new HttpError(400, 'kind must be age_id or photo_selfie');
  if (kind === 'age_id' && user.verification_status === 'verified') throw new HttpError(400, 'Already verified');
  if (kind === 'photo_selfie') {
    if (user.verification_status !== 'verified') throw new HttpError(403, 'Complete age verification first.', { code: 'verification_required' });
    if (user.photo_verified) throw new HttpError(400, 'Photo already verified');
    const ph = await one(`SELECT 1 FROM photos WHERE user_id=$1 AND status='approved' LIMIT 1`, [user.id]);
    if (!ph) throw new HttpError(400, 'Add at least one approved profile photo before photo verification.');
  }
  const recent = await one(`SELECT COUNT(*) c FROM verifications WHERE user_id=$1 AND created_at > NOW() - INTERVAL '24 hours'`, [user.id]);
  if (Number(recent.c) >= 5) throw new HttpError(429, 'Too many verification attempts today. Try again tomorrow.', { code: 'rate_limited' });

  const provider = getProvider();
  const sessionRef = crypto.randomUUID();
  const { redirectUrl } = await provider.createSession({ user, kind, sessionRef });
  await query(`INSERT INTO verifications (user_id, kind, provider, session_ref) VALUES ($1,$2,$3,$4)`, [user.id, kind, provider.name, sessionRef]);
  if (kind === 'age_id') {
    await query(`UPDATE users SET verification_status='pending', verification_submitted_at=NOW(), verification_provider=$2, verification_provider_ref=$3 WHERE id=$1`,
      [user.id, provider.name, sessionRef]);
  }
  return { status: 'pending', redirectUrl, sessionRef, provider: provider.name };
}

async function applyResult({ sessionRef, result, verifiedDob, over18, reason }) {
  const v = await one('SELECT * FROM verifications WHERE session_ref=$1', [sessionRef]);
  if (!v) throw new HttpError(404, 'No matching verification session');
  if (v.status !== 'pending') return { ok: true, replay: true };          // idempotent
  const user = await one('SELECT * FROM users WHERE id=$1', [v.user_id]);
  if (!user) throw new HttpError(404, 'User not found');

  if (v.kind === 'photo_selfie') {
    if (result === 'verified') {
      await query(`UPDATE users SET photo_verified=true, photo_verified_at=NOW() WHERE id=$1`, [user.id]);
      await query(`UPDATE verifications SET status='verified', completed_at=NOW() WHERE id=$1`, [v.id]);
      await notify(user.id, { type: 'account', title: 'Photo verified ✓', body: 'Your profile now shows the Verified badge.' });
    } else {
      await query(`UPDATE verifications SET status='rejected', reason=$2, completed_at=NOW() WHERE id=$1`, [v.id, reason || 'not_verified']);
      await recordSignal(user.id, 'photo_mismatch', { reason });
      await notify(user.id, { type: 'account', title: 'Photo verification failed', body: 'We could not match your selfie to your photos. You can try again.' });
    }
    return { ok: true };
  }

  // ---- age / identity ----
  const effectiveDob = verifiedDob || null;
  const age = effectiveDob ? ageFromDob(effectiveDob) : null;
  const under18 = (age != null && age < 18) || over18 === false;
  if (result === 'verified' && under18) {
    await query(`UPDATE verifications SET status='rejected', reason='under_minimum_age', verified_dob=$2, over_18=false, completed_at=NOW() WHERE id=$1`, [v.id, effectiveDob]);
    await query(`UPDATE users SET verification_status='rejected', verification_reviewed_at=NOW(), verification_rejection_reason='under_minimum_age',
                 status='suspended', status_reason='underage', suspended_until=NULL, token_version=token_version+1 WHERE id=$1`, [user.id]);
    await query(`INSERT INTO moderation_actions (user_id, actor_id, action, reason, previous_status) VALUES ($1,NULL,'suspend','underage_detected_by_verification',$2)`, [user.id, user.status]);
    await query(`INSERT INTO banned_identities (kind, hash, reason) VALUES ('email',$1,'underage') ON CONFLICT DO NOTHING`, [sha256(user.email.toLowerCase())]);
    await audit(null, 'verification.underage', 'user', user.id, { sessionRef });
    disconnectUser(user.id, 'suspended');
    return { ok: true, rejected: 'under_minimum_age' };
  }
  if (result === 'verified') {
    if (age == null && over18 !== true) {
      // No age evidence from the provider → do not verify.
      await query(`UPDATE verifications SET status='rejected', reason='no_age_evidence', completed_at=NOW() WHERE id=$1`, [v.id]);
      await query(`UPDATE users SET verification_status='rejected', verification_reviewed_at=NOW(), verification_rejection_reason='no_age_evidence' WHERE id=$1`, [user.id]);
      return { ok: true, rejected: 'no_age_evidence' };
    }
    // Verified DOB (when supplied) overrides whatever the user typed.
    await query(`UPDATE verifications SET status='verified', over_18=true, verified_dob=$2, completed_at=NOW() WHERE id=$1`, [v.id, effectiveDob]);
    await query(`UPDATE users SET verification_status='verified', verification_reviewed_at=NOW(), verification_rejection_reason=NULL,
                 over_18=true, verified_age=$2, dob=COALESCE($3::date, dob), age=COALESCE($2, age) WHERE id=$1`, [user.id, age, effectiveDob]);
    await notify(user.id, { type: 'account', title: 'You are verified ✓', body: 'Age verification passed — you can now discover, match and chat.' });
    return { ok: true };
  }
  await query(`UPDATE verifications SET status='rejected', reason=$2, completed_at=NOW() WHERE id=$1`, [v.id, reason || 'not_verified']);
  await query(`UPDATE users SET verification_status='rejected', verification_reviewed_at=NOW(), verification_rejection_reason=$2 WHERE id=$1`, [user.id, reason || 'not_verified']);
  return { ok: true };
}

module.exports = { start, applyResult, getProvider, providerConfigured };
