const test = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');
const verification = require('../services/verification');
const persona = require('../services/verification/providers/persona');
const { hmacHex, sha256 } = require('../lib/util');
const { request, app } = h;

test.before(h.setup);
test.after(h.teardown);
const SECRET = 'whsec_verification_test';
const hook = (body, secret = SECRET) => { const raw = JSON.stringify(body); return request(app).post('/api/verification/webhook').set('Content-Type', 'application/json').set('x-verification-signature', 'sha256=' + hmacHex(secret, raw)).send(raw); };
const start = async (u, kind = 'age_id') => (await h.as(u).post('/api/verification/start', { kind })).body;
const unverified = (o) => h.createUser({ verification_status: 'unverified', over_18: false, ...o });
const withEnv = async (env, fn) => { const old = {}; for (const k of Object.keys(env)) { old[k] = process.env[k]; env[k] === undefined ? delete process.env[k] : (process.env[k] = env[k]); } try { return await fn(); } finally { for (const k of Object.keys(old)) old[k] === undefined ? delete process.env[k] : (process.env[k] = old[k]); } };

test('start → pending → signed provider webhook → verified; replays are no-ops', async () => {
  const u = await unverified();
  const s = await start(u); assert.ok(s.redirectUrl.includes('verify-mock')); assert.strictEqual(s.status, 'pending');
  assert.strictEqual((await h.fresh(u.id)).verification_status, 'pending');
  const ref = new URL(s.redirectUrl, 'http://x').searchParams.get('ref');
  const r = await hook({ sessionRef: ref, result: 'verified', verifiedDob: '1994-03-03' });
  assert.strictEqual(r.status, 200);
  const row = await h.fresh(u.id);
  assert.deepStrictEqual([row.verification_status, row.over_18, new Date(row.dob).toISOString().slice(0, 10)], ['verified', true, '1994-03-03'], 'provider DOB overrides self-reported DOB');
  assert.strictEqual((await hook({ sessionRef: ref, result: 'rejected' })).body.replay, true, 'a finished session cannot be flipped');
  assert.strictEqual((await h.fresh(u.id)).verification_status, 'verified');
  assert.strictEqual((await h.as(u).get('/api/users/discover')).status, 200, 'gate opens');
  assert.strictEqual((await h.as(u).put('/api/users/me', { dob: '1980-01-01' })).body.code, 'dob_locked');
});

test('webhook rejects bad signatures, missing signatures, unknown sessions and garbage', async () => {
  const u = await unverified(); const ref = new URL((await start(u)).redirectUrl, 'http://x').searchParams.get('ref');
  assert.strictEqual((await hook({ sessionRef: ref, result: 'verified', verifiedDob: '1990-01-01' }, 'attacker')).status, 401);
  assert.strictEqual((await request(app).post('/api/verification/webhook').set('Content-Type', 'application/json').send('{"sessionRef":"x","result":"verified"}')).status, 401);
  assert.strictEqual((await hook({ sessionRef: 'nope', result: 'verified', verifiedDob: '1990-01-01' })).status, 404);
  assert.strictEqual((await hook({ result: 'verified' })).status, 400);
  assert.strictEqual((await h.fresh(u.id)).verification_status, 'pending');
});

test('UNDER-18 result: rejected, account suspended, sessions revoked, identity blocked from re-registering', async () => {
  const u = await unverified({ email: 'minor@example.com' }); const ref = new URL((await start(u)).redirectUrl, 'http://x').searchParams.get('ref');
  const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - 16);
  const r = await hook({ sessionRef: ref, result: 'verified', verifiedDob: d.toISOString().slice(0, 10) });
  assert.strictEqual(r.body.rejected, 'under_minimum_age');
  const row = await h.fresh(u.id);
  assert.deepStrictEqual([row.verification_status, row.status], ['rejected', 'suspended']);
  assert.strictEqual((await h.as(u).get('/api/users/discover')).status, 401, 'old token revoked');
  assert.ok((await h.db.query(`SELECT 1 FROM banned_identities WHERE hash=$1`, [sha256('minor@example.com')])).rowCount);
  assert.strictEqual((await request(app).post('/api/auth/signup').send({ email: 'minor@example.com', password: 'password123', name: 'M', dob: '1990-01-01', acceptTerms: true })).body.code, 'banned_identity');
  assert.ok((await h.db.query(`SELECT 1 FROM moderation_actions WHERE user_id=$1 AND reason='underage_detected_by_verification'`, [u.id])).rowCount, 'logged as a safety event');
  const u2 = await unverified(); const ref2 = new URL((await start(u2)).redirectUrl, 'http://x').searchParams.get('ref');
  assert.strictEqual((await hook({ sessionRef: ref2, result: 'verified', over18: false })).body.rejected, 'under_minimum_age', 'provider over18=false also blocks');
});

test('a "verified" result without any age evidence is not accepted; provider rejection sticks', async () => {
  const u = await unverified(); const ref = new URL((await start(u)).redirectUrl, 'http://x').searchParams.get('ref');
  assert.strictEqual((await hook({ sessionRef: ref, result: 'verified' })).body.rejected, 'no_age_evidence');
  const u2 = await unverified(); const ref2 = new URL((await start(u2)).redirectUrl, 'http://x').searchParams.get('ref');
  await hook({ sessionRef: ref2, result: 'rejected', reason: 'document_unreadable' });
  const row = await h.fresh(u2.id); assert.deepStrictEqual([row.verification_status, row.verification_rejection_reason], ['rejected', 'document_unreadable']);
  assert.strictEqual(typeof (await start(u2)).redirectUrl, 'string', 'can retry after rejection');
});

test('photo verification (blue badge) needs age verification first and an approved photo; failure raises a risk signal', async () => {
  const u = await unverified();
  assert.strictEqual((await h.as(u).post('/api/verification/start', { kind: 'photo_selfie' })).body.code, 'verification_required');
  const v = await h.createUser({ photo_verified: false });
  const ref = new URL((await start(v, 'photo_selfie')).redirectUrl, 'http://x').searchParams.get('ref');
  await hook({ sessionRef: ref, result: 'verified' });
  assert.strictEqual((await h.fresh(v.id)).photo_verified, true);
  assert.strictEqual((await h.as(v).post('/api/verification/start', { kind: 'photo_selfie' })).status, 400, 'already verified');
  const w = await h.createUser({ photo_verified: false });
  const ref2 = new URL((await start(w, 'photo_selfie')).redirectUrl, 'http://x').searchParams.get('ref');
  await hook({ sessionRef: ref2, result: 'rejected', reason: 'face_mismatch' });
  assert.strictEqual((await h.fresh(w.id)).photo_verified, false);
  assert.ok((await h.db.query(`SELECT 1 FROM risk_signals WHERE user_id=$1 AND signal='photo_mismatch'`, [w.id])).rowCount);
  const noPhoto = await h.createUser({ noPhotos: true });
  assert.strictEqual((await h.as(noPhoto).post('/api/verification/start', { kind: 'photo_selfie' })).status, 400);
});

test('PRODUCTION: the mock provider is unavailable and dev-complete does not exist', async () => {
  const u = await unverified(); const s = await start(u);
  const ref = new URL(s.redirectUrl, 'http://x').searchParams.get('ref');
  await withEnv({ NODE_ENV: 'production' }, async () => {
    assert.throws(() => verification.getProvider(), /No identity-verification provider|disabled in production/);
    assert.strictEqual(verification.providerConfigured(), false);
    assert.strictEqual((await h.as(u).post('/api/verification/start', { kind: 'age_id' })).status, 501);
    assert.strictEqual((await h.as(u).post('/api/verification/dev-complete', { sessionRef: ref, result: 'verified' })).status, 404);
    assert.strictEqual((await request(app).get('/api/auth/config')).body.verificationProviderConfigured, false);
  });
  assert.strictEqual((await h.as(u).post('/api/verification/dev-complete', { sessionRef: ref, result: 'verified' })).status, 200, 'still works outside production');
});

test('start attempts are limited per day', async () => {
  const u = await unverified();
  for (let i = 0; i < 5; i++) await start(u);
  assert.strictEqual((await h.as(u).post('/api/verification/start', { kind: 'age_id' })).status, 429);
});

test('Persona adapter verifies HMAC + freshness of its signature scheme', () => {
  const secret = SECRET; const body = Buffer.from(JSON.stringify({ data: { id: 'evt_1', attributes: { name: 'inquiry.approved', payload: { data: { attributes: { 'reference-id': 'ref-1' } }, included: [{ attributes: { birthdate: '1991-02-03' } }] } } } }));
  const t = Math.floor(Date.now() / 1000);
  const good = persona.parseWebhook(body, { 'persona-signature': `t=${t},v1=${hmacHex(secret, `${t}.${body}`)}` });
  assert.deepStrictEqual([good.sessionRef, good.result, good.verifiedDob], ['ref-1', 'verified', '1991-02-03']);
  assert.strictEqual(persona.parseWebhook(body, { 'persona-signature': `t=${t},v1=abc` }).status, 401);
  const old = t - 3600; assert.strictEqual(persona.parseWebhook(body, { 'persona-signature': `t=${old},v1=${hmacHex(secret, `${old}.${body}`)}` }).status, 401, 'stale');
});
