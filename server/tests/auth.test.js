const test = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');
const { request, app, db } = h;
const googleAuth = require('../lib/googleAuth');
const mailer = require('../lib/mailer');
const sms = require('../lib/sms');
const { sha256 } = require('../lib/util');

test.before(h.setup);
test.after(h.teardown);

const signup = (o = {}) => request(app).post('/api/auth/signup').send({ email: 'new@example.com', password: 'password123', name: 'New', dob: '1995-05-05', gender: 'woman', acceptTerms: true, ...o });

test('signup stores DOB, computes age, sets cookie, never returns password', async () => {
  const r = await signup();
  assert.strictEqual(r.status, 201);
  assert.ok(r.body.token); assert.ok(r.body.user.age >= 30); assert.strictEqual(r.body.user.dob, '1995-05-05');
  assert.strictEqual(r.body.user.verificationStatus, 'unverified');
  assert.ok(!JSON.stringify(r.body).includes('password'));
  assert.ok((r.headers['set-cookie'] || []).some((c) => c.startsWith('mf_rt=') && /HttpOnly/i.test(c)));
});

test('under-18 signup is rejected server-side (by DOB), as is a missing DOB or terms', async () => {
  const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - 17);
  let r = await signup({ email: 'kid@example.com', dob: d.toISOString().slice(0, 10) });
  assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'underage');
  const turns18Tomorrow = new Date(); turns18Tomorrow.setUTCFullYear(turns18Tomorrow.getUTCFullYear() - 18); turns18Tomorrow.setUTCDate(turns18Tomorrow.getUTCDate() + 1);
  r = await signup({ email: 'edge@example.com', dob: turns18Tomorrow.toISOString().slice(0, 10) });
  assert.strictEqual(r.status, 400, 'one day short of 18 is still rejected');
  assert.strictEqual((await signup({ email: 'nodob@example.com', dob: undefined })).status, 400);
  assert.strictEqual((await signup({ email: 'noterms@example.com', acceptTerms: false })).body.code, 'terms_required');
  assert.strictEqual((await signup({ email: 'bad', })).status, 400);
  assert.strictEqual((await signup({ email: 'short@example.com', password: '123' })).status, 400);
  assert.strictEqual((await signup()).status, 409, 'duplicate email');
});

test('login, lockout after repeated failures, and generic errors', async () => {
  await signup({ email: 'lock@example.com' });
  assert.strictEqual((await request(app).post('/api/auth/login').send({ email: 'lock@example.com', password: 'password123' })).status, 200);
  for (let i = 0; i < 8; i++) await request(app).post('/api/auth/login').send({ email: 'lock@example.com', password: 'wrong-pass' });
  const r = await request(app).post('/api/auth/login').send({ email: 'lock@example.com', password: 'password123' });
  assert.strictEqual(r.status, 429); assert.strictEqual(r.body.code, 'locked');
  const nobody = await request(app).post('/api/auth/login').send({ email: 'nobody@example.com', password: 'x' });
  assert.strictEqual(nobody.status, 401);
});

test('refresh token rotation, CSRF header, logout, logout-everywhere revokes access tokens', async () => {
  const agent = request.agent(app);
  const s = await agent.post('/api/auth/signup').send({ email: 'ref@example.com', password: 'password123', name: 'Ref', dob: '1990-01-01', acceptTerms: true });
  assert.strictEqual((await agent.post('/api/auth/refresh')).status, 403, 'missing CSRF header');
  const r1 = await agent.post('/api/auth/refresh').set('X-Matchify-CSRF', '1');
  assert.strictEqual(r1.status, 200); assert.ok(r1.body.token);
  assert.strictEqual((await h.authed(r1.body.token).get('/api/auth/me')).status, 200);
  // logout-all bumps token_version → earlier access tokens die immediately
  await h.authed(r1.body.token).post('/api/auth/logout-all');
  assert.strictEqual((await h.authed(s.body.token).get('/api/auth/me')).status, 401);
  assert.strictEqual((await h.authed(r1.body.token).get('/api/auth/me')).status, 401);
  assert.strictEqual((await agent.post('/api/auth/refresh').set('X-Matchify-CSRF', '1')).status, 401, 'refresh cookie revoked');
});

test('Google sign-in: verifies token, links only verified emails, creates account needing DOB', async () => {
  googleAuth.setVerifier(async (cred) => {
    if (cred === 'unverified') return { sub: 'g1', email: 'gg@example.com', emailVerified: false, name: 'G' };
    if (cred === 'newuser') return { sub: 'g-new', email: 'guser@example.com', emailVerified: true, name: 'Guser' };
    if (cred === 'link') return { sub: 'g-link', email: 'ref@example.com', emailVerified: true, name: 'Ref' };
    throw new Error('bad');
  });
  assert.strictEqual((await request(app).post('/api/auth/google').send({ credential: 'garbage' })).status, 401);
  assert.strictEqual((await request(app).post('/api/auth/google').send({ credential: 'unverified', acceptTerms: true })).status, 403);
  assert.strictEqual((await request(app).post('/api/auth/google').send({ credential: 'newuser' })).body.code, 'terms_required');
  const n = await request(app).post('/api/auth/google').send({ credential: 'newuser', acceptTerms: true });
  assert.strictEqual(n.status, 200); assert.strictEqual(n.body.isNew, true); assert.strictEqual(n.body.user.needsDob, true); assert.strictEqual(n.body.user.emailVerified, true);
  // DOB via profile update; under-18 rejected
  assert.strictEqual((await h.authed(n.body.token).put('/api/users/me', { dob: '2015-01-01' })).status, 400);
  assert.strictEqual((await h.authed(n.body.token).put('/api/users/me', { dob: '1994-04-04' })).status, 200);
  const l = await request(app).post('/api/auth/google').send({ credential: 'link' });
  assert.strictEqual(l.status, 200); assert.strictEqual(l.body.user.email, 'ref@example.com');
  googleAuth.setVerifier(null);
});

test('email verification link works once and expires', async () => {
  const s = await signup({ email: 'ev@example.com' });
  mailer.outbox.length = 0;
  await h.authed(s.body.token).post('/api/auth/email/send');
  const mail = mailer.outbox.find((m) => m.to === 'ev@example.com');
  const token = mail.text.match(/verify_email=([a-f0-9]+)/)[1];
  assert.strictEqual((await request(app).post('/api/auth/email/verify').send({ token })).status, 200);
  assert.strictEqual((await request(app).post('/api/auth/email/verify').send({ token })).status, 400, 'single use');
  assert.strictEqual((await h.authed(s.body.token).get('/api/auth/me')).body.user.emailVerified, true);
  const s2 = await signup({ email: 'ev2@example.com' });
  await h.authed(s2.body.token).post('/api/auth/email/send');
  await db.query(`UPDATE email_tokens SET expires_at = NOW() - INTERVAL '1 minute'`);
  const m2 = mailer.outbox.filter((m) => m.to === 'ev2@example.com').pop();
  assert.strictEqual((await request(app).post('/api/auth/email/verify').send({ token: m2.text.match(/verify_email=([a-f0-9]+)/)[1] })).status, 400);
});

test('phone OTP: hashed at rest, wrong code rejected, attempts limited, unique per verified phone', async () => {
  const a = await signup({ email: 'p1@example.com' }), b = await signup({ email: 'p2@example.com' });
  sms.outbox.length = 0;
  assert.strictEqual((await h.authed(a.body.token).post('/api/auth/phone/send', { phone: 'abc' })).status, 400);
  assert.strictEqual((await h.authed(a.body.token).post('/api/auth/phone/send', { phone: '9876543210' })).status, 200);
  const code = sms.outbox.pop().body.match(/(\d{6})/)[1];
  const stored = (await db.query('SELECT code_hash FROM otp_codes ORDER BY id DESC LIMIT 1')).rows[0].code_hash;
  assert.ok(!stored.includes(code) && stored.length === 64, 'OTP is not stored in plaintext');
  assert.strictEqual((await h.authed(a.body.token).post('/api/auth/phone/verify', { phone: '+919876543210', code: code === '000000' ? '111111' : '000000' })).status, 400);
  const ok = await h.authed(a.body.token).post('/api/auth/phone/verify', { phone: '+919876543210', code });
  assert.strictEqual(ok.status, 200); assert.strictEqual(ok.body.user.phoneVerified, true);
  assert.ok(!JSON.stringify(ok.body).includes('9876543210'), 'phone is masked in API output');
  assert.strictEqual((await h.authed(b.body.token).post('/api/auth/phone/send', { phone: '9876543210' })).status, 409, 'phone already linked');
  // brute force: 5 wrong attempts burn the code
  await h.authed(b.body.token).post('/api/auth/phone/send', { phone: '9123456780' });
  const real = sms.outbox.pop().body.match(/(\d{6})/)[1];
  for (let i = 0; i < 5; i++) await h.authed(b.body.token).post('/api/auth/phone/verify', { phone: '+919123456780', code: real === '123456' ? '654321' : '123456' });
  assert.strictEqual((await h.authed(b.body.token).post('/api/auth/phone/verify', { phone: '+919123456780', code: real })).status, 429);
});

test('password reset flow revokes sessions and never reveals whether an email exists', async () => {
  const s = await signup({ email: 'rs@example.com' });
  mailer.outbox.length = 0;
  assert.strictEqual((await request(app).post('/api/auth/forgot').send({ email: 'ghost@example.com' })).status, 200);
  assert.strictEqual(mailer.outbox.length, 0);
  await request(app).post('/api/auth/forgot').send({ email: 'rs@example.com' });
  const token = mailer.outbox[0].text.match(/reset_token=([a-f0-9]+)/)[1];
  assert.strictEqual((await request(app).post('/api/auth/reset').send({ token, password: 'brand-new-pass' })).status, 200);
  assert.strictEqual((await h.authed(s.body.token).get('/api/auth/me')).status, 401, 'old access token revoked');
  assert.strictEqual((await request(app).post('/api/auth/login').send({ email: 'rs@example.com', password: 'brand-new-pass' })).status, 200);
});

test('banned identities cannot re-register; disposable emails and signup bursts raise risk signals', async () => {
  await db.query(`INSERT INTO banned_identities (kind, hash) VALUES ('email',$1)`, [sha256('banned@example.com')]);
  assert.strictEqual((await signup({ email: 'Banned@Example.com' })).body.code, 'banned_identity');
  const d = await signup({ email: 'x@mailinator.com' });
  const sig = await db.query(`SELECT signal FROM risk_signals WHERE user_id=$1`, [d.body.user.id]);
  assert.ok(sig.rows.some((r) => r.signal === 'disposable_email'));
});

test('new-device login sends a security alert email', async () => {
  await signup({ email: 'nd@example.com' });
  mailer.outbox.length = 0;
  await request(app).post('/api/auth/login').set('User-Agent', 'BrandNewPhone/9').send({ email: 'nd@example.com', password: 'password123' });
  assert.ok(mailer.outbox.some((m) => m.to === 'nd@example.com' && /New sign-in/.test(m.subject)));
});
