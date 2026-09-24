const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const h = require('./helpers');
const cfg = require('../config');
const accounts = require('../services/accounts');
const storage = require('../lib/storage');
const { sha256 } = require('../lib/util');
const { request, app } = h;

test.before(h.setup);
test.after(h.teardown);
test.beforeEach(async () => { await h.resetDb(); });

test('profile validation: contact details, length, height, intent, prompts, interests', async () => {
  const u = await h.createUser();
  const put = (b) => h.as(u).put('/api/users/me', b);
  assert.strictEqual((await put({ bio: 'call me on 9876543210 anytime' })).status, 422);
  assert.strictEqual((await put({ bio: 'x'.repeat(cfg.MAX_BIO_LENGTH + 1) })).status, 400);
  assert.strictEqual((await put({ bio: 'Love hiking and chai.' })).status, 200);
  assert.strictEqual((await put({ heightCm: 50 })).status, 400);
  assert.strictEqual((await put({ relationshipIntent: 'world_domination' })).status, 400);
  assert.strictEqual((await put({ prefAgeMin: 40, prefAgeMax: 30 })).status, 400);
  assert.strictEqual((await put({ prompts: [{ key: 'nope', answer: 'x' }] })).status, 400);
  const tooMany = Array.from({ length: cfg.MAX_PROMPTS + 1 }, (_, i) => ({ key: cfg.PROMPT_KEYS[i], answer: 'a' }));
  assert.strictEqual((await put({ prompts: tooMany })).status, 400);
  const ok = await put({ prompts: [{ key: cfg.PROMPT_KEYS[0], answer: 'Long walks' }, { key: cfg.PROMPT_KEYS[0], answer: 'dup ignored' }], interests: ['Chess', 'chess', ' Jazz ', ''] });
  assert.strictEqual(ok.status, 200); assert.deepStrictEqual(ok.body.user.interests, ['Chess', 'Jazz']);
  assert.deepStrictEqual((await h.fresh(u.id)).interest_tags, ['chess', 'jazz']);
  assert.strictEqual((await h.db.query('SELECT COUNT(*) c FROM profile_prompts WHERE user_id=$1', [u.id])).rows[0].c, '1');
});

test('settings: pausing hides you from Discover; incognito is Pro-only; other users cannot change your settings', async () => {
  const me = await h.createUser({ gender: 'man' }), her = await h.createUser({ gender: 'woman' });
  assert.ok((await h.as(me).get('/api/users/discover')).body.profiles.some((p) => p.id === her.id));
  await h.as(her).put('/api/users/me/settings', { discoverable: false });
  assert.ok(!(await h.as(me).get('/api/users/discover')).body.profiles.some((p) => p.id === her.id), 'paused profile disappears');
  assert.strictEqual((await h.as(me).put('/api/users/me/settings', { incognito: true })).status, 402);
  const r = await h.as(me).put('/api/users/me/settings', { notificationPrefs: { message: false, bogus: true } });
  assert.strictEqual((await h.fresh(me.id)).notification_prefs.message, false); assert.strictEqual((await h.fresh(me.id)).notification_prefs.bogus, undefined);
});

test('account deletion: password required, sessions revoked, cancellable in the grace period, export works', async () => {
  const u = await h.createUser();
  assert.strictEqual((await h.as(u).post('/api/users/me/delete', { password: 'wrong' })).status, 401);
  assert.strictEqual((await h.as(u).post('/api/users/me/delete', { password: h.PW })).status, 200);
  const row = await h.fresh(u.id); assert.strictEqual(row.status, 'pending_deletion'); assert.strictEqual(row.discoverable, false);
  assert.strictEqual((await h.as(u).get('/api/matches')).status, 401, 'old sessions revoked');
  const l = await request(app).post('/api/auth/login').send({ email: u.email, password: h.PW });
  assert.strictEqual(l.status, 200, 'can log in during grace period');
  assert.strictEqual((await h.authed(l.body.token).get('/api/matches')).body.code, 'pending_deletion');
  const exp = await h.authed(l.body.token).get('/api/users/me/export');
  assert.strictEqual(exp.status, 200); assert.ok(exp.headers['content-disposition'].includes('attachment'));
  assert.ok(!('password_hash' in exp.body.profile) && exp.body.profile.email === u.email);
  const c = await h.authed(l.body.token).post('/api/users/me/delete/cancel');
  assert.strictEqual(c.body.ok, true); assert.strictEqual((await h.fresh(u.id)).status, 'active');
});

test('purge: hard-deletes profile, photos (files), matches and messages; keeps only a hashed safety record and report evidence', async () => {
  const [gone, other] = [await h.createUser({ email: 'leaving@example.com' }), await h.createUser()];
  const file = path.join(storage.LOCAL_DIR, `purge-test-${gone.id}.jpg`); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'x');
  await h.db.query(`UPDATE photos SET storage_key=$2 WHERE user_id=$1 AND position=0`, [gone.id, path.basename(file)]);
  const m = await h.makeMatch(gone, other);
  await h.db.query(`INSERT INTO messages (match_id, sender_id, text) VALUES ($1,$2,'hello'),($1,$3,'hi')`, [m.id, gone.id, other.id]);
  await h.db.query(`INSERT INTO reports (reporter_id, reported_id, reason, evidence, priority) VALUES ($1,$2,'harassment','{"messages":[{"text":"kept as evidence"}]}',1)`, [other.id, gone.id]);
  await h.db.query(`INSERT INTO moderation_actions (user_id, action, reason) VALUES ($1,'warn','earlier warning')`, [gone.id]);
  assert.strictEqual(await accounts.purgeUser(gone.id), true);
  assert.strictEqual((await h.db.query('SELECT COUNT(*) c FROM users WHERE id=$1', [gone.id])).rows[0].c, '0');
  for (const t of ['photos', 'matches', 'messages']) assert.strictEqual((await h.db.query(`SELECT COUNT(*) c FROM ${t} WHERE ${t === 'matches' ? 'user_a' : t === 'photos' ? 'user_id' : 'sender_id'}=$1`, [gone.id])).rows[0].c, '0', t);
  assert.strictEqual((await h.db.query('SELECT COUNT(*) c FROM messages WHERE match_id=$1', [m.id])).rows[0].c, '0');
  assert.ok(!fs.existsSync(file), 'image file removed from storage');
  const rec = (await h.db.query('SELECT * FROM deleted_account_records')).rows[0];
  assert.strictEqual(rec.email_hash, sha256('leaving@example.com')); assert.strictEqual(rec.had_enforcement, true); assert.ok(!JSON.stringify(rec).includes('leaving@example.com'));
  const rep = (await h.db.query('SELECT reported_id, evidence FROM reports')).rows[0];
  assert.strictEqual(rep.reported_id, null); assert.strictEqual(rep.evidence.messages[0].text, 'kept as evidence');
  // a banned account that deletes itself stays blocked from returning
  const bad = await h.createUser({ email: 'banned-leaver@example.com', status: 'banned' });
  await accounts.purgeUser(bad.id);
  assert.strictEqual((await request(app).post('/api/auth/signup').send({ email: 'banned-leaver@example.com', password: 'password123', name: 'B', dob: '1990-01-01', acceptTerms: true })).body.code, 'banned_identity');
});

test('analytics endpoint returns only the caller’s own numbers', async () => {
  const a = await h.createUser(), b = await h.createUser();
  await h.db.query('INSERT INTO profile_views (viewer_id, viewed_id) VALUES ($1,$2)', [b.id, a.id]);
  assert.strictEqual((await h.as(a).get('/api/users/me/analytics')).body.last7Days.profileViews, 1);
  assert.strictEqual((await h.as(b).get('/api/users/me/analytics')).body.last7Days.profileViews, 0);
});
