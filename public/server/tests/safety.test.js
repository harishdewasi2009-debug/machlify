const test = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');
const totp = require('../lib/totp');
const risk = require('../lib/risk');
const tokens = require('../services/tokens');
const { sha256 } = require('../lib/util');
const { request, app } = h;

let srv;
test.before(async () => { await h.setup(); srv = await h.startServer(); });
test.after(async () => { await srv.close(); await h.teardown(); });

async function staff(role) { return h.createUser({ role, name: role + '-staff' }); }
const login = async (u) => (await request(app).post('/api/auth/login').send({ email: u.email, password: h.PW }));

test('report → queue → moderator assigns & suspends → user notified, audit trail written, reporter thanked', async () => {
  await h.resetDb();
  const [reporter, bad, mod] = [await h.createUser(), await h.createUser(), await staff('moderator')];
  const m = await h.makeMatch(reporter, bad);
  await h.as(bad).post(`/api/matches/${m.id}/messages`, { text: 'you are ugly' });
  const rep = await h.as(reporter).post('/api/safety/report', { userId: bad.id, reason: 'harassment', matchId: m.id });
  const minor = await h.as(reporter).post('/api/safety/report', { userId: (await h.createUser()).id, reason: 'underage_suspected' });
  const q = await h.as(mod).get('/api/admin/reports');
  assert.strictEqual(q.status, 200); assert.deepStrictEqual(q.body.reports.map((r) => r.priority), [1, 1], 'under-18 suspicion and harassment are both priority 1, oldest first');
  assert.ok(q.body.reports.some((r) => r.id === minor.body.id));
  const detail = await h.as(mod).get(`/api/admin/reports/${rep.body.id}`);
  assert.strictEqual(detail.body.report.evidence.messages[0].text, 'you are ugly');
  assert.strictEqual((await h.as(mod).post(`/api/admin/reports/${rep.body.id}/assign`)).status, 200);
  assert.strictEqual((await h.db.query('SELECT status FROM reports WHERE id=$1', [rep.body.id])).rows[0].status, 'in_review');
  assert.strictEqual((await h.as(mod).post(`/api/admin/reports/${rep.body.id}/resolve`, { decision: 'action', action: 'suspend', reason: 'Harassing messages', days: 7 })).status, 200);
  const u = await h.fresh(bad.id);
  assert.strictEqual(u.status, 'suspended'); assert.ok(new Date(u.suspended_until) > Date.now() + 6 * 864e5);
  assert.strictEqual((await h.as(bad).get('/api/matches')).status, 401, 'sessions revoked');
  const l = await login(bad); assert.strictEqual(l.status, 200, 'suspended users can still log in to see status/appeal');
  assert.strictEqual((await h.authed(l.body.token).get('/api/matches')).status, 403);
  assert.strictEqual((await h.authed(l.body.token).get('/api/safety/status')).body.status, 'suspended');
  const acts = (await h.db.query('SELECT action FROM audit_log ORDER BY id')).rows.map((r) => r.action);
  for (const a of ['admin.view_report', 'report.assign', 'moderation.suspend']) assert.ok(acts.includes(a), 'audited: ' + a);
  assert.strictEqual((await h.db.query('SELECT status, resolved_by FROM reports WHERE id=$1', [rep.body.id])).rows[0].status, 'actioned');
  await h.sleep(150);
  assert.ok((await h.db.query(`SELECT 1 FROM notifications WHERE user_id=$1 AND type='safety'`, [reporter.id])).rowCount, 'reporter notified');
  assert.strictEqual((await h.as(mod).post(`/api/admin/reports/${rep.body.id}/resolve`, { decision: 'dismiss' })).status, 409, 'already resolved');
});

test('appeal → admin overturns → account restored; upheld stays suspended', async () => {
  await h.resetDb();
  const [admin, u1, u2] = [await staff('admin'), await h.createUser(), await h.createUser()];
  for (const u of [u1, u2]) await h.as(admin).post(`/api/admin/users/${u.id}/action`, { action: 'suspend', reason: 'test', days: 3 });
  const l1 = await login(u1), l2 = await login(u2);
  assert.strictEqual((await h.authed(l1.body.token).post('/api/safety/appeals', { message: 'short' })).status, 400);
  const a1 = await h.authed(l1.body.token).post('/api/safety/appeals', { message: 'This was a mistake, please review.' });
  assert.strictEqual((await h.authed(l1.body.token).post('/api/safety/appeals', { message: 'Second appeal attempt here' })).status, 409, 'one open appeal at a time');
  const a2 = await h.authed(l2.body.token).post('/api/safety/appeals', { message: 'Please look again at my case.' });
  assert.strictEqual((await h.as(admin).get('/api/admin/appeals')).body.appeals.length, 2);
  assert.strictEqual((await h.as(admin).post(`/api/admin/appeals/${a1.body.id}/resolve`, { decision: 'overturned', note: 'ok' })).status, 200);
  await h.as(admin).post(`/api/admin/appeals/${a2.body.id}/resolve`, { decision: 'upheld', note: 'stands' });
  assert.strictEqual((await h.fresh(u1.id)).status, 'active'); assert.strictEqual((await h.fresh(u2.id)).status, 'suspended');
  assert.ok((await h.db.query('SELECT 1 FROM moderation_actions WHERE user_id=$1 AND reversed_at IS NOT NULL', [u1.id])).rowCount);
});

test('RBAC: users get 403 on /admin; moderators cannot ban/unban/see payments/audit/config/change roles; admins can', async () => {
  await h.resetDb();
  const [user, mod, admin, target] = [await h.createUser(), await staff('moderator'), await staff('admin'), await h.createUser()];
  assert.strictEqual((await h.as(user).get('/api/admin/stats')).status, 403);
  assert.strictEqual((await request(app).get('/api/admin/stats')).status, 401);
  assert.strictEqual((await h.as(mod).get('/api/admin/stats')).status, 200);
  assert.strictEqual((await h.as(mod).post(`/api/admin/users/${target.id}/action`, { action: 'ban', reason: 'nope nope' })).status, 403);
  for (const p of ['/api/admin/payments', '/api/admin/audit', '/api/admin/config']) assert.strictEqual((await h.as(mod).get(p)).status, 403, p);
  assert.strictEqual((await h.as(mod).post(`/api/admin/users/${target.id}/role`, { role: 'admin' })).status, 403);
  assert.strictEqual((await h.as(mod).post(`/api/admin/users/${admin.id}/action`, { action: 'warn', reason: 'sneaky' })).status, 403, 'cannot act on staff');
  assert.strictEqual((await h.as(mod).post(`/api/admin/users/${target.id}/action`, { action: 'suspend', reason: 'long one', days: 90 })).status, 400, 'moderators max 30 days');
  assert.strictEqual((await h.as(mod).post(`/api/admin/users/${target.id}/action`, { action: 'warn', reason: '' })).status, 400, 'reason required');
  assert.strictEqual((await h.as(mod).post(`/api/admin/users/${mod.id}/action`, { action: 'restrict', reason: 'self' })).status, 400);
  for (const p of ['/api/admin/payments', '/api/admin/audit', '/api/admin/config']) assert.strictEqual((await h.as(admin).get(p)).status, 200, p);
  assert.strictEqual((await h.as(admin).post(`/api/admin/users/${target.id}/role`, { role: 'moderator' })).status, 200);
  assert.strictEqual((await h.as(admin).post(`/api/admin/users/${admin.id}/role`, { role: 'user' })).status, 400, 'cannot demote yourself');
  const detail = await h.as(mod).get(`/api/admin/users/${target.id}`);
  assert.strictEqual(detail.status, 200); assert.ok(!('password_hash' in detail.body.user) && !('staff_totp_secret' in detail.body.user));
  assert.deepStrictEqual(detail.body.payments, [], 'moderators do not see payment data');
});

test('staff 2FA (TOTP): required for all admin routes when enabled; bound to the staff member', async () => {
  await h.resetDb();
  process.env.REQUIRE_STAFF_2FA = 'true';
  try {
    const admin = await staff('admin'); const other = await staff('admin');
    assert.strictEqual((await h.as(admin).get('/api/admin/stats')).body.code, 'staff_2fa_required');
    const me = await h.as(admin).get('/api/admin/me'); assert.strictEqual(me.status, 200, 'setup routes are reachable without the 2FA token');
    const setup = await h.as(admin).post('/api/admin/2fa/setup'); assert.ok(setup.body.otpauthUrl.startsWith('otpauth://totp/'));
    assert.strictEqual((await h.as(admin).post('/api/admin/2fa/verify', { code: '000000' })).status, 401);
    const v = await h.as(admin).post('/api/admin/2fa/verify', { code: totp.code(setup.body.secret) });
    assert.strictEqual(v.status, 200);
    const t = v.body.adminToken;
    const ok = await request(app).get('/api/admin/stats').set('Authorization', 'Bearer ' + admin.token).set('x-admin-token', t);
    assert.strictEqual(ok.status, 200);
    const stolen = await request(app).get('/api/admin/stats').set('Authorization', 'Bearer ' + other.token).set('x-admin-token', t);
    assert.strictEqual(stolen.status, 401, 'token cannot be used by another staff account');
    assert.strictEqual((await request(app).get('/api/admin/stats').set('Authorization', 'Bearer ' + admin.token).set('x-admin-token', 'junk')).status, 401);
    assert.strictEqual((await h.as(admin).post('/api/admin/2fa/setup')).status, 400, 'cannot re-setup once enabled');
  } finally { delete process.env.REQUIRE_STAFF_2FA; }
});

test('ban: revokes sessions, kicks live sockets, blocks re-signup with the same email; unban is admin-only and restores', async () => {
  await h.resetDb();
  const [admin, bad] = [await staff('admin'), await h.createUser({ email: 'trouble@example.com' })];
  const s = await srv.connect(bad.token);
  const kicked = h.waitFor(s, 'force:logout');
  assert.strictEqual((await h.as(admin).post(`/api/admin/users/${bad.id}/action`, { action: 'ban', reason: 'Scam operation' })).status, 200);
  await kicked;
  assert.strictEqual((await login(bad)).body.code, 'account_banned');
  assert.strictEqual((await request(app).post('/api/auth/signup').send({ email: 'TROUBLE@example.com', password: 'password123', name: 'T', dob: '1990-01-01', acceptTerms: true })).body.code, 'banned_identity');
  assert.ok((await h.db.query('SELECT 1 FROM banned_identities WHERE hash=$1', [sha256('trouble@example.com')])).rowCount);
  assert.strictEqual((await h.as(admin).post(`/api/admin/users/${bad.id}/action`, { action: 'unban', reason: 'Appeal accepted' })).status, 200);
  assert.strictEqual((await login(bad)).status, 200);
});

test('risk engine: explainable signals accumulate; HIGH auto-restricts and queues a system report; moderators can restore', async () => {
  await h.resetDb();
  const [mod, u] = [await staff('moderator'), await h.createUser()];
  assert.deepStrictEqual(await risk.recordSignal(u.id, 'signup_velocity', { ip_count: 5 }), { score: 25, level: 'low' });
  assert.strictEqual(await risk.recordSignal(u.id, 'signup_velocity', {}), null, 'same signal is de-duplicated within the hour');
  assert.strictEqual((await risk.recordSignal(u.id, 'disposable_email')).level, 'medium');
  assert.strictEqual((await risk.recordSignal(u.id, 'repeated_message', { n: 6 })).level, 'high');
  assert.strictEqual((await h.fresh(u.id)).status, 'restricted');
  const rep = await h.db.query(`SELECT * FROM reports WHERE reported_id=$1 AND source='system'`, [u.id]);
  assert.strictEqual(rep.rowCount, 1); assert.strictEqual(rep.rows[0].priority, 1); assert.ok(rep.rows[0].evidence.signals.length === 3, 'evidence lists the reasons');
  assert.ok((await h.as(mod).get('/api/admin/risk')).body.users.some((x) => x.id === u.id));
  const d = await h.as(mod).get(`/api/admin/users/${u.id}`);
  assert.deepStrictEqual(d.body.riskSignals.map((s) => s.signal).sort(), ['disposable_email', 'repeated_message', 'signup_velocity']);
  assert.strictEqual((await h.as(u).post('/api/swipes', { targetId: 1, action: 'like' })).status, 403);
  assert.ok(!JSON.stringify((await h.as(u).get('/api/auth/me')).body).includes('risk'), 'users never see their risk score');
  await h.as(mod).post(`/api/admin/users/${u.id}/action`, { action: 'unrestrict', reason: 'Reviewed, legitimate' });
  assert.strictEqual((await h.fresh(u.id)).status, 'active');
  const staffUser = await staff('admin'); await risk.recordSignal(staffUser.id, 'repeated_message'); await risk.recordSignal(staffUser.id, 'duplicate_photo');
  assert.strictEqual((await h.fresh(staffUser.id)).status, 'active', 'staff are never auto-restricted');
});

test('photo review queue: needs_review photos are hidden until a moderator approves; rejected photos are removed', async () => {
  await h.resetDb();
  const [mod, u] = [await staff('moderator'), await h.createUser({ noPhotos: true })];
  const ids = [];
  for (let i = 0; i < 2; i++) ids.push((await h.db.query(`INSERT INTO photos (user_id, url, thumb_url, storage_key, position, status) VALUES ($1,$2,$2,$3,$4,'needs_review') RETURNING id`, [u.id, `/uploads/x${i}.jpg`, `u${u.id}/x${i}.jpg`, i])).rows[0].id);
  require('../services/profile').refreshProfile(u.id);
  assert.deepStrictEqual(JSON.parse((await h.fresh(u.id)).photos), [], 'unreviewed photos are not public');
  assert.strictEqual((await h.as(mod).get('/api/admin/photos/queue')).body.photos.length, 2);
  await h.as(mod).post(`/api/admin/photos/${ids[0]}/review`, { decision: 'approve' });
  await h.as(mod).post(`/api/admin/photos/${ids[1]}/review`, { decision: 'reject' });
  assert.strictEqual(JSON.parse((await h.fresh(u.id)).photos).length, 1);
  assert.strictEqual((await h.db.query('SELECT status, url FROM photos WHERE id=$1', [ids[1]])).rows[0].url, 'rejected');
  assert.strictEqual((await h.as(mod).post(`/api/admin/photos/${ids[0]}/review`, { decision: 'maybe' })).status, 400);
});

test('admin stats exclude demo profiles; force re-verify resets verification', async () => {
  await h.resetDb();
  const [mod, real] = [await staff('moderator'), await h.createUser()];
  await h.createUser({ is_demo: true, email: 'd1@demo.matchify.invalid' }); await h.createUser({ is_demo: true, email: 'd2@demo.matchify.invalid' });
  const s = await h.as(mod).get('/api/admin/stats');
  assert.strictEqual(s.body.users.total, 2, 'real user + staff only');
  assert.strictEqual((await h.as(mod).get('/api/admin/users')).body.users.some((u) => u.is_demo), false);
  await h.as(mod).post(`/api/admin/users/${real.id}/verification`, { reason: 'Photo does not match ID' });
  const row = await h.fresh(real.id); assert.deepStrictEqual([row.verification_status, row.over_18, row.photo_verified], ['unverified', false, false]);
  assert.strictEqual((await h.as(real).get('/api/users/discover')).status, 403, 'locked until they re-verify');
});
