const test = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');

let srv;
test.before(async () => { await h.setup(); srv = await h.startServer(); });
test.after(async () => { await srv.close(); await h.teardown(); });

const REST = [
  ['get', '/api/users/discover'], ['get', '/api/users/likes-you'], ['get', '/api/users/recommendations'],
  ['post', '/api/swipes', { targetId: 1, action: 'like' }], ['get', '/api/matches'], ['get', '/api/matches/1/messages'],
  ['post', '/api/matches/1/messages', { text: 'hi' }], ['post', '/api/ai/companion', { message: 'hello' }], ['post', '/api/users/me/boost'],
];

async function matrix(user, expectStatus, expectCode) {
  for (const [m, url, body] of REST) {
    const r = await h.as(user)[m](url, body);
    assert.strictEqual(r.status, expectStatus, `${m.toUpperCase()} ${url} → ${r.status} ${JSON.stringify(r.body)}`);
    if (expectCode) assert.strictEqual(r.body.code, expectCode, `${url} code`);
  }
}

test('unverified / pending / rejected users are locked out of every social feature (REST)', async () => {
  for (const vs of ['unverified', 'pending', 'rejected']) {
    await matrix(await h.createUser({ verification_status: vs }), 403, 'verification_required');
  }
});

test('users without a date of birth or with restricted status are blocked', async () => {
  await matrix(await h.createUser({ dob: null, age: null }), 403, 'dob_required');
  await matrix(await h.createUser({ status: 'restricted' }), 403, 'account_restricted');
});

test('suspended, banned and pending-deletion accounts cannot use the API at all', async () => {
  for (const [status, code] of [['suspended', 'account_suspended'], ['banned', 'account_banned'], ['pending_deletion', 'pending_deletion']]) {
    const u = await h.createUser({ status });
    for (const url of ['/api/users/discover', '/api/matches', '/api/photos']) {
      const r = await h.as(u).get(url);
      assert.strictEqual(r.status, 403, url); assert.strictEqual(r.body.code, code);
    }
  }
});

test('users lacking 2 approved photos cannot discover or swipe', async () => {
  const u = await h.createUser({ photoCount: 1 });
  const r = await h.as(u).get('/api/users/discover');
  assert.strictEqual(r.status, 403); assert.strictEqual(r.body.code, 'profile_incomplete');
});

test('sockets: banned/suspended cannot connect; unverified can connect but every social event is refused', async () => {
  const banned = await h.createUser({ status: 'banned' });
  await assert.rejects(srv.connect(banned.token), /account_banned/);
  const susp = await h.createUser({ status: 'suspended' });
  await assert.rejects(srv.connect(susp.token), /account_suspended/);
  await assert.rejects(srv.connect('garbage'));

  const un = await h.createUser({ verification_status: 'pending' });
  const other = await h.createUser();
  const m = await h.makeMatch(un, other);
  const s = await srv.connect(un.token);
  for (const [ev, payload] of [
    ['message:send', { matchId: m.id, text: 'hi' }], ['typing:start', { matchId: m.id }],
    ['call:invite', { toUserId: other.id, matchId: m.id, callType: 'video' }],
    ['random:join', {}], ['message:read', { matchId: m.id }],
  ]) {
    const r = await h.emit(s, ev, payload);
    assert.strictEqual(r.ok, false, ev); assert.strictEqual(r.code, 'verification_required', ev);
  }
});

test('a token issued before a ban/logout-all stops working on live sockets', async () => {
  const u = await h.createUser(); const o = await h.createUser(); const m = await h.makeMatch(u, o);
  const s = await srv.connect(u.token);
  assert.strictEqual((await h.emit(s, 'message:send', { matchId: m.id, text: 'hello there' })).ok, true);
  await h.db.query('UPDATE users SET token_version = token_version + 1 WHERE id=$1', [u.id]);
  const forced = h.waitFor(s, 'force:logout');
  const r = await h.emit(s, 'message:send', { matchId: m.id, text: 'still here?' });
  assert.strictEqual(r.ok, false); assert.strictEqual(r.code, 'session_invalid');
  await forced;
});
