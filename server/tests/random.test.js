const test = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');
const cfg = require('../config');
const random = require('../services/randomTalk');

let srv;
test.before(async () => { await h.setup(); srv = await h.startServer(); });
test.after(async () => { await srv.close(); await h.teardown(); });
test.beforeEach(async () => { random.reset(); await h.db.query('TRUNCATE random_skips, random_messages, random_sessions, matches, reports RESTART IDENTITY CASCADE'); });

const ru = (o = {}) => h.createUser({ random_rules_accepted_at: new Date(), ...o });
const join = (s, f = {}) => h.emit(s, 'random:join', f);
const matchCount = async () => Number((await h.db.query('SELECT COUNT(*) c FROM matches')).rows[0].c);

test('rules must be accepted first; only verified adults can join', async () => {
  const u = await h.createUser(); const s = await srv.connect(u.token);
  assert.strictEqual((await join(s)).code, 'rules_required');
  assert.strictEqual((await h.as(u).post('/api/users/me/random-rules')).status, 200);
  assert.strictEqual((await join(s)).ok, true);
  const unv = await ru({ verification_status: 'pending' });
  assert.strictEqual((await join(await srv.connect(unv.token))).code, 'verification_required');
});

test('two queued users are paired; a user who is not in the queue is NEVER paired', async () => {
  const [a, b, c] = [await ru(), await ru(), await ru()];
  const [sa, sb, sc] = await Promise.all([a, b, c].map((u) => srv.connect(u.token)));   // c is online but NOT queued
  const pa = h.waitFor(sa, 'random:paired'), pb = h.waitFor(sb, 'random:paired');
  const noPair = h.expectNo(sc, 'random:paired', 600);
  const r1 = await join(sa); assert.strictEqual(r1.waiting, true);
  const r2 = await join(sb); assert.strictEqual(r2.waiting, false);
  const [x, y] = await Promise.all([pa, pb]);
  assert.strictEqual(x.sessionId, y.sessionId);
  await noPair;
  // partner card is anonymous: first name, age, country, interests — no photos/email/id
  assert.ok(!('photos' in x.partner) && !('email' in x.partner) && !('id' in x.partner));
  assert.deepStrictEqual(Object.keys(x.partner).sort(), ['age', 'country', 'interests', 'name', 'verified']);
  assert.strictEqual(await matchCount(), 0, 'a session is NOT a match');
  assert.strictEqual((await join(sa)).code, 'in_session');
});

test('filters must be acceptable to BOTH people; blocks and recent skips prevent pairing', async () => {
  const w = await ru({ gender: 'woman', country: 'India' }), m1 = await ru({ gender: 'man', country: 'India' }), m2 = await ru({ gender: 'man', country: 'UK' });
  const [sw, s1, s2] = await Promise.all([w, m1, m2].map((u) => srv.connect(u.token)));
  await join(sw, { gender: 'men', country: 'India' });
  const none = h.expectNo(s2, 'random:paired', 500);
  await join(s2, {}); await none;                                    // UK man: wrong country for her filter
  const paired = h.waitFor(s1, 'random:paired');
  await join(s1, { gender: 'women' }); await paired;                 // Indian man accepted
  // a blocked pair is never matched
  random.reset();
  const a = await ru(), b = await ru(); await h.db.query('INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1,$2)', [a.id, b.id]);
  const [sa, sb] = await Promise.all([a, b].map((u) => srv.connect(u.token)));
  const n2 = h.expectNo(sa, 'random:paired', 500); await join(sa); await join(sb); await n2;
  assert.strictEqual(random.state().sessions, 0);
});

async function startSession() {
  random.reset(); await h.db.query('TRUNCATE random_skips, random_messages, random_sessions, matches RESTART IDENTITY CASCADE');
  const a = await ru(), b = await ru();
  const [sa, sb] = await Promise.all([a, b].map((u) => srv.connect(u.token)));
  const pa = h.waitFor(sa, 'random:paired'), pb = h.waitFor(sb, 'random:paired');
  await join(sa); await join(sb);
  const [x, y] = await Promise.all([pa, pb]);
  return { a, b, sa, sb, sid: x.sessionId };
}

test('messages flow both ways with moderation; transcripts are stored for reports', async () => {
  const { sa, sb, sid } = await startSession();
  const got = h.waitFor(sb, 'random:message');
  assert.strictEqual((await h.emit(sa, 'random:message', { sessionId: sid, text: 'hey, what music do you like?' })).ok, true);
  assert.strictEqual((await got).text, 'hey, what music do you like?');
  assert.strictEqual((await h.emit(sa, 'random:message', { sessionId: sid, text: 'send nudes' })).code, 'message_blocked');
  const warn = h.waitFor(sb, 'random:message');
  await h.emit(sa, 'random:message', { sessionId: sid, text: 'add me on telegram' });
  assert.ok((await warn).warning);
  assert.strictEqual((await h.emit(sa, 'random:message', { sessionId: 9999, text: 'x' })).code, 'session_not_found');
  assert.strictEqual((await h.db.query('SELECT COUNT(*) c FROM random_messages')).rows[0].c, '2');
});

test('SKIP ends the session for both, is remembered (no instant re-pair), creates no match, and is rate limited', async () => {
  const { a, b, sa, sb, sid } = await startSession();
  const ended = h.waitFor(sb, 'random:ended');
  assert.strictEqual((await h.emit(sa, 'random:skip', { sessionId: sid })).ok, true);
  assert.strictEqual((await ended).reason, 'partner_skipped');
  assert.strictEqual(await matchCount(), 0, 'no permanent match from a skipped session');
  assert.strictEqual((await h.db.query('SELECT status FROM random_sessions')).rows[0].status, 'skipped');
  const none = h.expectNo(sa, 'random:paired', 500);
  await join(sa); await join(sb); await none;                        // skipped pair is not re-matched for an hour
  random.reset();
  await h.db.query(`INSERT INTO random_skips (user_id, other_id, created_at) SELECT $1, $2, NOW() FROM generate_series(1, $3)`, [a.id, b.id, cfg.RANDOM_SKIPS_PER_HOUR]);
  assert.strictEqual((await join(sa)).code, 'skip_limit');
});

test('KEEP becomes a match ONLY if both people choose it', async () => {
  let { a, b, sa, sb, sid } = await startSession();
  const status = h.waitFor(sb, 'random:keep_status');
  const r = await h.emit(sa, 'random:keep', { sessionId: sid });
  assert.strictEqual(r.waitingForPartner, true); assert.strictEqual((await status).partnerWantsToKeep, true);
  assert.strictEqual(await matchCount(), 0, 'one-sided keep creates nothing');
  const ma = h.waitFor(sa, 'random:matched'), mb = h.waitFor(sb, 'random:matched');
  assert.strictEqual((await h.emit(sb, 'random:keep', { sessionId: sid })).matched, true);
  const [x] = await Promise.all([ma, mb]);
  const m = (await h.db.query('SELECT * FROM matches')).rows[0];
  assert.strictEqual(m.id, x.matchId); assert.strictEqual(m.source, 'random_talk'); assert.strictEqual(m.status, 'active');
  assert.strictEqual((await h.db.query('SELECT status FROM random_sessions')).rows[0].status, 'kept');
  assert.strictEqual((await h.as(a).get('/api/matches')).body.matches.length, 1);
  // both can now chat in the normal match
  assert.strictEqual((await h.as(b).post(`/api/matches/${m.id}/messages`, { text: 'nice to meet you' })).status, 201);
});

test('voice/video needs BOTH to enable it; signalling is refused until then', async () => {
  const { sa, sb, sid } = await startSession();
  assert.strictEqual((await h.emit(sa, 'random:signal', { sessionId: sid, data: { sdp: 'x' } })).code, 'media_not_enabled');
  const asked = h.waitFor(sb, 'random:media_requested');
  assert.strictEqual((await h.emit(sa, 'random:enable', { sessionId: sid, kind: 'voice' })).enabled, false); await asked;
  assert.strictEqual((await h.emit(sa, 'random:signal', { sessionId: sid, data: { sdp: 'x' } })).ok, false, 'one side is not enough');
  const both = h.waitFor(sa, 'random:media_enabled');
  assert.strictEqual((await h.emit(sb, 'random:enable', { sessionId: sid, kind: 'voice' })).enabled, true); await both;
  const sig = h.waitFor(sb, 'random:signal');
  assert.strictEqual((await h.emit(sa, 'random:signal', { sessionId: sid, data: { sdp: 'offer' } })).ok, true);
  assert.deepStrictEqual((await sig).data, { sdp: 'offer' });
  assert.strictEqual((await h.emit(sa, 'random:enable', { sessionId: sid, kind: 'telepathy' })).ok, false);
});

test('REPORT from a session captures the transcript, ends the session, and needs no match', async () => {
  const { a, b, sa, sb, sid } = await startSession();
  await h.emit(sb, 'random:message', { sessionId: sid, text: 'you look boring' });
  const ended = h.waitFor(sb, 'random:ended');
  const r = await h.as(a).post('/api/safety/report', { userId: b.id, reason: 'harassment', sessionId: sid });
  assert.strictEqual(r.status, 201);
  const rep = (await h.db.query('SELECT * FROM reports WHERE id=$1', [r.body.id])).rows[0];
  assert.strictEqual(rep.context, 'random_talk'); assert.strictEqual(rep.evidence.messages[0].text, 'you look boring');
  await ended;
  assert.strictEqual(random.state().sessions, 0); assert.strictEqual(await matchCount(), 0);
  assert.strictEqual((await h.db.query('SELECT status FROM random_sessions')).rows[0].status, 'reported');
  const dup = await h.as(a).post('/api/safety/report', { userId: b.id, reason: 'harassment', sessionId: 424242 });
  assert.strictEqual(dup.body.duplicate, true, 'repeat reports within 24h are deduped');
  const bogus = await h.as(b).post('/api/safety/report', { userId: a.id, reason: 'spam_or_scam', sessionId: 424242 });
  assert.strictEqual(bogus.status, 201);
  assert.strictEqual((await h.db.query('SELECT context, evidence FROM reports WHERE id=$1', [bogus.body.id])).rows[0].context, 'profile', 'a session the reporter was not in yields no transcript');
});

test('disconnecting ends the session for the partner; leaving/timeouts remove people from the queue', async () => {
  const { sa, sb } = await startSession();
  const ended = h.waitFor(sb, 'random:ended'); sa.close();
  assert.strictEqual((await ended).reason, 'partner_left');
  const u = await ru(); const s = await srv.connect(u.token);
  await join(s); assert.strictEqual(random.isQueued(u.id), true);
  await h.emit(s, 'random:leave'); assert.strictEqual(random.isQueued(u.id), false);
  const orig = cfg.RANDOM_QUEUE_TIMEOUT_MS; cfg.RANDOM_QUEUE_TIMEOUT_MS = -1;
  await join(s); const to = h.waitFor(s, 'random:timeout'); await random.sweepQueue(); await to; cfg.RANDOM_QUEUE_TIMEOUT_MS = orig;
  assert.strictEqual(random.isQueued(u.id), false);
});

test('the legacy no-consent endpoint is gone', async () => {
  const u = await ru(); await ru();
  const r = await h.as(u).post('/api/users/random-talk');
  assert.strictEqual(r.status, 410); assert.strictEqual(await matchCount(), 0);
});
