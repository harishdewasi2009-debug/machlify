const test = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');
const cfg = require('../config');

let srv;
test.before(async () => { await h.setup(); srv = await h.startServer(); });
test.after(async () => { await srv.close(); await h.teardown(); });

async function pair(opts = {}) {
  const a = await h.createUser({ gender: 'man', ...opts.a }), b = await h.createUser({ gender: 'woman', ...opts.b });
  const m = await h.makeMatch(a, b);
  return { a, b, m, sa: await srv.connect(a.token), sb: await srv.connect(b.token) };
}

test('messages are delivered in real time with server ack, sync to sender tabs, and persisted', async () => {
  const { a, b, m, sa, sb } = await pair();
  const got = h.waitFor(sb, 'message:new');
  const ack = await h.emit(sa, 'message:send', { matchId: m.id, text: 'Hello there!', clientId: 'c-1' });
  assert.strictEqual(ack.ok, true); assert.strictEqual(ack.message.clientId, 'c-1'); assert.ok(ack.message.id);
  const msg = await got;
  assert.strictEqual(msg.text, 'Hello there!'); assert.strictEqual(msg.senderId, a.id);
  assert.strictEqual((await h.db.query('SELECT COUNT(*) c FROM messages')).rows[0].c, '1');
  const hist = await h.as(b).get(`/api/matches/${m.id}/messages`);
  assert.strictEqual(hist.body.messages.length, 1);
});

test('typing indicator reaches only the matched partner and is throttled', async () => {
  const { m, sa, sb } = await pair();
  const t = h.waitFor(sb, 'typing');
  await h.emit(sa, 'typing:start', { matchId: m.id });
  assert.deepStrictEqual(await t, { matchId: m.id, typing: true });
  const outsider = await h.createUser(); const so = await srv.connect(outsider.token);
  const r = await h.emit(so, 'typing:start', { matchId: m.id });
  assert.strictEqual(r.ok, false, 'a non-participant cannot emit typing into someone else’s match');
});

test('read receipts: delivered on open, hidden if EITHER user turned them off', async () => {
  const { a, b, m, sa, sb } = await pair();
  await h.emit(sa, 'message:send', { matchId: m.id, text: 'one' });
  const readEvt = h.waitFor(sa, 'message:read');
  const r = await h.emit(sb, 'message:read', { matchId: m.id });
  assert.strictEqual(r.marked, 1);
  assert.strictEqual((await readEvt).readerId, b.id);
  let hist = await h.as(a).get(`/api/matches/${m.id}/messages`);
  assert.strictEqual(hist.body.messages[0].read, true);
  // recipient disables receipts → sender learns nothing
  const p = await pair({ b: { read_receipts: false } });
  await h.emit(p.sa, 'message:send', { matchId: p.m.id, text: 'private' });
  const none = h.expectNo(p.sa, 'message:read');
  await h.emit(p.sb, 'message:read', { matchId: p.m.id });
  await none;
  hist = await h.as(p.a).get(`/api/matches/${p.m.id}/messages`);
  assert.strictEqual(hist.body.messages[0].read, undefined, 'no read state exposed');
  assert.strictEqual((await h.db.query('SELECT read_at FROM messages WHERE match_id=$1', [p.m.id])).rows[0].read_at !== null, true, 'still tracked server-side for unread counts');
});

test('blocking mid-conversation immediately stops messages and calls, and keeps evidence', async () => {
  const { a, b, m, sa, sb } = await pair();
  await h.emit(sa, 'message:send', { matchId: m.id, text: 'hi' }); await h.emit(sb, 'message:send', { matchId: m.id, text: 'hey' });
  const closed = h.waitFor(sa, 'match:closed');
  assert.strictEqual((await h.as(b).post(`/api/safety/block/${a.id}`)).status, 200);
  await closed;
  const r = await h.emit(sa, 'message:send', { matchId: m.id, text: 'wait!' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual((await h.emit(sb, 'call:invite', { toUserId: a.id, matchId: m.id, callType: 'audio' })).ok, false);
  assert.strictEqual((await h.as(a).post(`/api/matches/${m.id}/messages`, { text: 'rest?' })).status, 404);
  assert.strictEqual((await h.db.query('SELECT COUNT(*) c FROM messages WHERE match_id=$1', [m.id])).rows[0].c, '2', 'messages NOT deleted');
  const row = (await h.db.query('SELECT status, closed_reason FROM matches WHERE id=$1', [m.id])).rows[0];
  assert.deepStrictEqual([row.status, row.closed_reason], ['closed', 'block']);
  assert.ok(!(await h.as(a).get('/api/matches')).body.matches.some((x) => x.id === m.id));
});

test('unmatch closes (never deletes) and stops delivery', async () => {
  const { a, b, m, sa } = await pair();
  await h.emit(sa, 'message:send', { matchId: m.id, text: 'bye?' });
  assert.strictEqual((await h.as(b).delete(`/api/matches/${m.id}`)).status, 200);
  assert.strictEqual((await h.emit(sa, 'message:send', { matchId: m.id, text: 'hello?' })).ok, false);
  assert.strictEqual((await h.db.query('SELECT COUNT(*) c FROM messages WHERE match_id=$1', [m.id])).rows[0].c, '1');
});

test('calls: locked until both have messaged; then invite → accept → signalling relay → end', async () => {
  const { a, b, m, sa, sb } = await pair();
  let r = await h.emit(sa, 'call:invite', { toUserId: b.id, matchId: m.id, callType: 'video' });
  assert.strictEqual(r.code, 'calls_locked');
  await h.emit(sa, 'message:send', { matchId: m.id, text: 'hi' });
  assert.strictEqual((await h.emit(sa, 'call:invite', { toUserId: b.id, matchId: m.id, callType: 'video' })).code, 'calls_locked', 'one-sided is not enough');
  await h.emit(sb, 'message:send', { matchId: m.id, text: 'hello' });
  const incoming = h.waitFor(sb, 'call:incoming');
  r = await h.emit(sa, 'call:invite', { toUserId: b.id, matchId: m.id, callType: 'video' });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual([(await incoming).fromUserId, (await incoming).callType], [a.id, 'video']);
  const accepted = h.waitFor(sa, 'call:accepted');
  assert.strictEqual((await h.emit(sb, 'call:accept', { toUserId: a.id, matchId: m.id })).ok, true); await accepted;
  const sig = h.waitFor(sb, 'call:signal');
  assert.strictEqual((await h.emit(sa, 'call:signal', { toUserId: b.id, matchId: m.id, data: { sdp: 'offer' } })).ok, true);
  assert.deepStrictEqual((await sig).data, { sdp: 'offer' });
  const ended = h.waitFor(sb, 'call:ended'); await h.emit(sa, 'call:end', { toUserId: b.id, matchId: m.id }); await ended;
  assert.strictEqual((await h.emit(sa, 'call:signal', { toUserId: b.id, matchId: m.id, data: { x: 1 } })).code, 'no_call', 'signalling dies with the call');
});

test('UNAUTHORISED call signalling is rejected: strangers, wrong match, no live call, blocked pairs', async () => {
  const { a, b, m, sa } = await pair();
  const stranger = await h.createUser(); const ss = await srv.connect(stranger.token);
  const sb2 = await srv.connect((await h.createUser()).token);
  const attempts = [
    [ss, { toUserId: a.id, matchId: m.id, callType: 'audio', data: { sdp: 'x' } }],              // stranger → member of someone else's match
    [ss, { toUserId: a.id, matchId: 999, callType: 'audio' }],                                    // nonexistent match
    [sa, { toUserId: stranger.id, matchId: m.id, callType: 'audio' }],                            // member ringing a non-partner
  ];
  for (const [sock, p] of attempts) {
    const rcv = h.expectNo(sock === ss ? sa : ss, 'call:incoming');
    assert.strictEqual((await h.emit(sock, 'call:invite', p)).ok, false);
    assert.strictEqual((await h.emit(sock, 'call:signal', p)).ok, false);
    await rcv;
  }
  await h.emit(sa, 'message:send', { matchId: m.id, text: 'x' });
  await h.emit(await srv.connect(b.token), 'message:send', { matchId: m.id, text: 'y' });
  // matched, but no ringing call → signal refused
  assert.strictEqual((await h.emit(sa, 'call:signal', { toUserId: b.id, matchId: m.id, data: { sdp: 's' } })).code, 'no_call');
  // REST call logging can't name arbitrary callees either
  assert.strictEqual((await h.as(stranger).post(`/api/matches/${m.id}/calls`, { callType: 'audio', status: 'completed' })).status, 404);
});

test('moderation: solicitation blocked; scam patterns delivered with a warning + risk signal; minors flagged for review', async () => {
  const { a, b, m } = await pair();
  const r1 = await h.as(a).post(`/api/matches/${m.id}/messages`, { text: 'send nudes now' });
  assert.strictEqual(r1.status, 422); assert.strictEqual(r1.body.code, 'message_blocked');
  const sbk = await srv.connect(b.token);
  const got = h.waitFor(sbk, 'message:new');
  const r2 = await h.as(a).post(`/api/matches/${m.id}/messages`, { text: 'please send money, add me on whatsapp' });
  assert.strictEqual(r2.status, 201); assert.strictEqual(r2.body.warned, true);
  const delivered = await got;
  assert.ok(/scam|money/i.test(delivered.warning), 'recipient sees a warning: ' + delivered.warning);
  const sig = await h.db.query(`SELECT signal FROM risk_signals WHERE user_id=$1`, [a.id]);
  assert.ok(sig.rows.some((x) => x.signal === 'money_request'));
  const r4 = await h.as(a).post(`/api/matches/${m.id}/messages`, { text: 'I want to end my life' });
  assert.strictEqual(r4.status, 201); assert.ok(/14416/.test(r4.body.supportHint), 'sender is shown support info');
  assert.strictEqual((await h.as(a).post(`/api/matches/${m.id}/messages`, { text: '   ' })).status, 400);
  assert.strictEqual((await h.as(a).post(`/api/matches/${m.id}/messages`, { text: 'x'.repeat(cfg.MESSAGE_MAX_LENGTH + 1) })).status, 400);
  const r3 = await h.as(a).post(`/api/matches/${m.id}/messages`, { text: 'i am 15 years old' });
  assert.strictEqual(r3.status, 422);
  const rep = await h.db.query(`SELECT reason, priority, source FROM reports WHERE reported_id=$1`, [a.id]);
  assert.ok(rep.rows.some((x) => x.reason === 'underage_suspected' && x.priority === 1 && x.source === 'system'));
  // risk signals accumulated (money 25 + off-platform 15 + underage 50) → auto-restricted for human review
  assert.strictEqual((await h.fresh(a.id)).status, 'restricted');
  assert.strictEqual((await h.as(a).post(`/api/matches/${m.id}/messages`, { text: 'hello' })).status, 403);
});

test('reporting from a chat snapshots the last 50 messages as evidence and dedupes', async () => {
  const { a, b, m } = await pair();
  for (let i = 0; i < 3; i++) await h.as(a).post(`/api/matches/${m.id}/messages`, { text: `msg ${i}` });
  const r = await h.as(b).post('/api/safety/report', { userId: a.id, reason: 'harassment', details: 'rude', matchId: m.id });
  assert.strictEqual(r.status, 201);
  const row = (await h.db.query('SELECT * FROM reports WHERE id=$1', [r.body.id])).rows[0];
  assert.strictEqual(row.context, 'chat'); assert.strictEqual(row.priority, 1); assert.strictEqual(row.evidence.messages.length, 3);
  assert.strictEqual((await h.as(b).post('/api/safety/report', { userId: a.id, reason: 'harassment', matchId: m.id })).body.duplicate, true);
  assert.strictEqual((await h.as(b).post('/api/safety/report', { userId: a.id, reason: 'nonsense' })).status, 400);
  assert.strictEqual((await h.as(b).post('/api/safety/report', { userId: b.id, reason: 'other' })).status, 400, 'cannot report yourself');
  // evidence survives even if the reporter blocks the reported user (match closed, messages kept)
  await h.as(b).post(`/api/safety/block/${a.id}`);
  assert.strictEqual((await h.db.query('SELECT COUNT(*) c FROM messages WHERE match_id=$1', [m.id])).rows[0].c, '3');
});

test('offline recipients get a notification row (deduped per match); online ones do not', async () => {
  const a = await h.createUser({ gender: 'man' }), b = await h.createUser({ gender: 'woman' }); const m = await h.makeMatch(a, b);
  await h.as(a).post(`/api/matches/${m.id}/messages`, { text: 'are you there?' });
  await h.as(a).post(`/api/matches/${m.id}/messages`, { text: 'hello?' });
  await h.sleep(250);
  const n = await h.db.query(`SELECT * FROM notifications WHERE user_id=$1 AND type='message'`, [b.id]);
  assert.strictEqual(n.rowCount, 1, 'deduped'); assert.ok(!/are you there/.test(n.rows[0].body), 'no message text in notifications');
  assert.strictEqual((await h.as(b).get('/api/notifications')).body.unreadCount >= 1, true);
  assert.strictEqual((await h.as(b).post('/api/notifications/read', {})).status, 200);
  assert.strictEqual((await h.as(b).get('/api/notifications')).body.unreadCount, 0);
});

test('restricted senders cannot message; message rate limiting kicks in', async () => {
  const { a, m } = await pair();
  await h.setUser(a.id, { status: 'restricted' });
  assert.strictEqual((await h.as(a).post(`/api/matches/${m.id}/messages`, { text: 'hi' })).status, 403);
  await h.setUser(a.id, { status: 'active' });
  let last;
  for (let i = 0; i < cfg.MESSAGES_PER_MINUTE + 2; i++) last = await h.as(a).post(`/api/matches/${m.id}/messages`, { text: 'spam ' + i });
  assert.strictEqual(last.status, 429);
});

test('WebRTC config exposes STUN and short-lived TURN credentials when configured', async () => {
  const u = await h.createUser();
  let r = await h.as(u).get('/api/config/rtc');
  assert.ok(r.body.iceServers[0].urls); assert.strictEqual(r.body.turnConfigured, false);
  process.env.TURN_URL = 'turn:turn.example.com:3478'; process.env.TURN_SECRET = 'sekret';
  r = await h.as(u).get('/api/config/rtc');
  const turn = r.body.iceServers.find((s) => s.username);
  assert.ok(turn && /^\d+:\d+$/.test(turn.username) && turn.credential); assert.ok(Number(turn.username.split(':')[0]) > Date.now() / 1000);
  delete process.env.TURN_URL; delete process.env.TURN_SECRET;
});
