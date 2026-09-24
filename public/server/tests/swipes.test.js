const test = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');
const cfg = require('../config');
const tokens = require('../services/tokens');

test.before(h.setup);
test.after(h.teardown);
const swipe = (u, targetId, action = 'like') => h.as(u).post('/api/swipes', { targetId, action });

test('free like cap is enforced server-side (429 + upgrade hint); passes are unlimited; caps are per-user', async () => {
  const orig = cfg.PLAN_ENTITLEMENTS.free.likesPerDay; cfg.PLAN_ENTITLEMENTS.free.likesPerDay = 3;
  try {
    const me = await h.createUser({ gender: 'man' });
    const targets = []; for (let i = 0; i < 6; i++) targets.push(await h.createUser({ gender: 'woman' }));
    for (let i = 0; i < 3; i++) assert.strictEqual((await swipe(me, targets[i].id)).status, 200);
    const over = await swipe(me, targets[3].id);
    assert.strictEqual(over.status, 429); assert.strictEqual(over.body.code, 'like_limit_reached'); assert.strictEqual(over.body.upgrade, true);
    assert.strictEqual((await swipe(me, targets[3].id, 'pass')).status, 200, 'passes never count');
    const q = await h.as(me).get('/api/swipes/quota');
    assert.deepStrictEqual([q.body.likes.used, q.body.likes.limit], [3, 3]);
    const other = await h.createUser({ gender: 'man' });
    assert.strictEqual((await swipe(other, targets[0].id)).status, 200, 'another user has their own quota');
    // paid plans lift the cap
    await h.setUser(me.id, { plan: 'premium', plan_expires_at: new Date(Date.now() + 864e5) }); me.token = tokens.signAccess(await h.fresh(me.id));
    assert.strictEqual((await swipe(me, targets[4].id)).status, 200, 'Premium has unlimited likes');
  } finally { cfg.PLAN_ENTITLEMENTS.free.likesPerDay = orig; }
});

test('the cap cannot be raced with parallel requests', async () => {
  const orig = cfg.PLAN_ENTITLEMENTS.free.likesPerDay; cfg.PLAN_ENTITLEMENTS.free.likesPerDay = 2;
  try {
    const me = await h.createUser({ gender: 'man' });
    const targets = []; for (let i = 0; i < 6; i++) targets.push(await h.createUser({ gender: 'woman' }));
    const rs = await Promise.all(targets.map((t) => swipe(me, t.id)));
    assert.strictEqual(rs.filter((r) => r.status === 200).length, 2);
  } finally { cfg.PLAN_ENTITLEMENTS.free.likesPerDay = orig; }
});

test('super-like cap, mutual like → match (both notified), re-swipe conflict, self/unknown/blocked targets', async () => {
  await h.resetDb();
  const a = await h.createUser({ gender: 'man' }), b = await h.createUser({ gender: 'woman' }), c = await h.createUser({ gender: 'woman' }), blocked = await h.createUser({ gender: 'woman' });
  assert.strictEqual((await swipe(a, b.id)).body.match, null);
  const m = await swipe(b, a.id);
  assert.strictEqual(m.status, 200); assert.ok(m.body.match.id); assert.strictEqual(m.body.match.user.id, a.id);
  await h.sleep(200);
  assert.strictEqual((await h.db.query(`SELECT COUNT(*) c FROM notifications WHERE type='match'`)).rows[0].c, '1', 'the person who liked first is notified');
  assert.strictEqual((await swipe(a, b.id)).status, 409, 'already swiped');
  assert.strictEqual((await swipe(a, a.id)).status, 400);
  assert.strictEqual((await swipe(a, 999999)).status, 404);
  await h.db.query('INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1,$2)', [blocked.id, a.id]);
  assert.strictEqual((await swipe(a, blocked.id)).status, 404, 'cannot swipe on someone who blocked you');
  assert.strictEqual((await swipe(a, c.id, 'superlike')).status, 200);
  const d = await h.createUser({ gender: 'woman' });
  const s2 = await swipe(a, d.id, 'superlike');
  assert.strictEqual(s2.status, 429); assert.strictEqual(s2.body.code, 'superlike_limit_reached');
  assert.strictEqual((await swipe(a, d.id, 'nope')).status, 400);
});

test('rewind: Plus and above only; undoes the last swipe inside the window; never after a match', async () => {
  await h.resetDb();
  const me = await h.createUser({ gender: 'man' }), t1 = await h.createUser({ gender: 'woman' }), t2 = await h.createUser({ gender: 'woman' });
  await swipe(me, t1.id, 'pass');
  let r = await h.as(me).post('/api/swipes/rewind');
  assert.strictEqual(r.status, 402); assert.strictEqual(r.body.code, 'upgrade_required');
  await h.setUser(me.id, { plan: 'plus', plan_expires_at: new Date(Date.now() + 864e5) }); me.token = tokens.signAccess(await h.fresh(me.id));
  r = await h.as(me).post('/api/swipes/rewind');
  assert.strictEqual(r.status, 200); assert.strictEqual(r.body.rewound.targetId, t1.id);
  assert.ok((await h.as(me).get('/api/users/discover?limit=50')).body.profiles.some((p) => p.id === t1.id), 'profile is back');
  assert.strictEqual((await h.as(me).post('/api/swipes/rewind')).status, 404, 'nothing left to rewind');
  // match created → cannot rewind it
  await swipe(t2, me.id); assert.ok((await swipe(me, t2.id)).body.match);
  assert.strictEqual((await h.as(me).post('/api/swipes/rewind')).status, 404);
  // window
  const t3 = await h.createUser({ gender: 'woman' }); await swipe(me, t3.id, 'pass');
  await h.db.query(`UPDATE swipes SET created_at = NOW() - INTERVAL '10 minutes' WHERE swiper_id=$1 AND target_id=$2`, [me.id, t3.id]);
  assert.strictEqual((await h.as(me).post('/api/swipes/rewind')).status, 404, 'outside 5-minute window');
  // rewinding does not refund the daily like count
  assert.ok(Number((await h.db.query(`SELECT COUNT(*) c FROM swipe_events WHERE user_id=$1`, [me.id])).rows[0].c) === 3, 'rewinds never delete swipe_events');
});

test('boost: monthly free boost for Premium, purchased credits otherwise, one active at a time', async () => {
  await h.resetDb();
  const me = await h.createUser({ gender: 'man' });
  let r = await h.as(me).post('/api/users/me/boost');
  assert.strictEqual(r.status, 402); assert.strictEqual(r.body.code, 'no_boost_credits');
  await h.setUser(me.id, { boost_credits: 2 });
  r = await h.as(me).post('/api/users/me/boost'); assert.strictEqual(r.status, 200); assert.strictEqual(r.body.boost.source, 'credit');
  assert.strictEqual((await h.as(me).post('/api/users/me/boost')).status, 409, 'already boosted');
  assert.strictEqual((await h.fresh(me.id)).boost_credits, 1);
  await h.db.query('UPDATE boosts SET ends_at = NOW() - INTERVAL \'1 minute\'');
  await h.setUser(me.id, { plan: 'premium', plan_expires_at: new Date(Date.now() + 864e5) }); me.token = tokens.signAccess(await h.fresh(me.id));
  r = await h.as(me).post('/api/users/me/boost'); assert.strictEqual(r.body.boost.source, 'monthly');
  await h.db.query('UPDATE boosts SET ends_at = NOW() - INTERVAL \'1 minute\'');
  r = await h.as(me).post('/api/users/me/boost'); assert.strictEqual(r.body.boost.source, 'credit', 'monthly boost is once per month');
});
