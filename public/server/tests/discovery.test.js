const test = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');
const tokens = require('../services/tokens');

test.before(h.setup);
test.after(h.teardown);
const idsOf = (r) => r.body.profiles.map((p) => p.id);
const fresh = async (u) => { u.token = tokens.signAccess(await h.fresh(u.id)); return u; };

test('mutual gender preferences are enforced in both directions', async () => {
  const me = await h.createUser({ gender: 'man', pref_genders: ['woman'] });
  const okW = await h.createUser({ gender: 'woman', pref_genders: ['man'] });
  const wantsWomenOnly = await h.createUser({ gender: 'woman', pref_genders: ['woman'] });
  const anyone = await h.createUser({ gender: 'woman', pref_genders: [] });
  const man = await h.createUser({ gender: 'man', pref_genders: [] });
  const ids = idsOf(await h.as(me).get('/api/users/discover?limit=50'));
  assert.ok(ids.includes(okW.id) && ids.includes(anyone.id));
  assert.ok(!ids.includes(wantsWomenOnly.id), 'she is not interested in men');
  assert.ok(!ids.includes(man.id), 'I am not interested in men');
});

test('age preferences apply both ways; under-18s never appear even with bad data', async () => {
  const me = await h.createUser({ gender: 'woman', dob: '1996-01-01', pref_age_min: 25, pref_age_max: 35, pref_genders: [] });
  const inRange = await h.createUser({ gender: 'man', dob: '1994-01-01', pref_age_min: 18, pref_age_max: 60 });
  const tooYoung = await h.createUser({ gender: 'man', dob: '2005-01-01', pref_age_min: 18, pref_age_max: 60 });
  const doesNotWantMe = await h.createUser({ gender: 'man', dob: '1994-01-01', pref_age_min: 18, pref_age_max: 25 });
  const minorRow = await h.createUser({ gender: 'man', dob: '2014-01-01', age: 12 });
  const ids = idsOf(await h.as(me).get('/api/users/discover?limit=50'));
  assert.ok(ids.includes(inRange.id)); assert.ok(!ids.includes(tooYoung.id)); assert.ok(!ids.includes(doesNotWantMe.id));
  assert.ok(!ids.includes(minorRow.id), 'a minor row can never be shown');
});

test('blocked users, swiped users, matched users, unverified/suspended/paused users are excluded', async () => {
  const me = await h.createUser({ gender: 'man' });
  const [blocked, blockedMe, swiped, matched, unverified, suspended, paused, restricted, deleted, good] = await Promise.all([
    h.createUser({ gender: 'woman' }), h.createUser({ gender: 'woman' }), h.createUser({ gender: 'woman' }), h.createUser({ gender: 'woman' }),
    h.createUser({ gender: 'woman', verification_status: 'pending' }), h.createUser({ gender: 'woman', status: 'suspended' }),
    h.createUser({ gender: 'woman', discoverable: false }), h.createUser({ gender: 'woman', status: 'restricted' }),
    h.createUser({ gender: 'woman', deleted_at: new Date() }), h.createUser({ gender: 'woman' })]);
  await h.db.query('INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1,$2),($3,$1)', [me.id, blocked.id, blockedMe.id]);
  await h.db.query(`INSERT INTO swipes (swiper_id, target_id, action) VALUES ($1,$2,'pass')`, [me.id, swiped.id]);
  await h.makeMatch(me, matched);
  const ids = idsOf(await h.as(me).get('/api/users/discover?limit=50'));
  assert.deepStrictEqual(ids.filter((i) => [good.id].includes(i)), [good.id]);
  for (const x of [blocked, blockedMe, swiped, matched, unverified, suspended, paused, restricted, deleted]) assert.ok(!ids.includes(x.id), 'should be hidden: ' + x.id);
});

test('modes: nearby (distance), city, country, global, new, verified, active, interests', async () => {
  await h.resetDb();
  const me = await h.createUser({ gender: 'man', location: 'Mumbai', country: 'India', lat: 19.08, lng: 72.88, pref_distance_km: 50, interests: ['chess', 'trekking'] });
  const near = await h.createUser({ gender: 'woman', location: 'Mumbai', lat: 19.12, lng: 72.9, interests: ['chess'], photo_verified: true });
  const farIndia = await h.createUser({ gender: 'woman', location: 'Delhi', country: 'India', lat: 28.61, lng: 77.2, interests: ['dance'] });
  const abroad = await h.createUser({ gender: 'woman', location: 'London', country: 'UK', lat: 51.5, lng: -0.12, interests: ['dance'], created_at: new Date(Date.now() - 40 * 864e5) });
  const inactive = await h.createUser({ gender: 'woman', location: 'Mumbai', lat: 19.1, lng: 72.9, last_active_at: new Date(Date.now() - 5 * 864e5), created_at: new Date(Date.now() - 40 * 864e5) });
  const g = async (q) => idsOf(await h.as(me).get('/api/users/discover?limit=50&' + q));
  const nearby = await g('mode=nearby'); assert.ok(nearby.includes(near.id) && !nearby.includes(farIndia.id) && !nearby.includes(abroad.id));
  const city = await g('mode=city'); assert.ok(city.includes(near.id) && city.includes(inactive.id) && !city.includes(farIndia.id));
  const country = await g('mode=country'); assert.ok(country.includes(farIndia.id) && !country.includes(abroad.id));
  const global = await g('mode=global'); assert.ok(global.includes(abroad.id) && global.length === 4);
  const nw = await g('mode=new'); assert.ok(nw.includes(near.id) && !nw.includes(abroad.id));
  const ver = await g('mode=verified'); assert.deepStrictEqual(ver, [near.id]);
  const act = await g('mode=active'); assert.ok(act.includes(near.id) && !act.includes(inactive.id));
  const int = await g('mode=interests'); assert.deepStrictEqual(int, [near.id]);
  assert.strictEqual((await h.as(me).get('/api/users/discover?mode=bogus')).status, 400);
  const noLoc = await h.createUser({ gender: 'man', lat: null, lng: null, location: '', country: '' });
  const r = await h.as(noLoc).get('/api/users/discover?mode=nearby');
  assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'location_required');
});

test('ranking: shared interests, proximity and boosts raise a profile; compat % is provided', async () => {
  await h.resetDb();
  const me = await h.createUser({ gender: 'man', interests: ['chess', 'trekking', 'jazz'], lat: 19.08, lng: 72.88 });
  const match = await h.createUser({ gender: 'woman', interests: ['chess', 'trekking', 'jazz'], lat: 19.09, lng: 72.89 });
  const meh = await h.createUser({ gender: 'woman', interests: ['knitting'], lat: 19.5, lng: 73.5 });
  let r = await h.as(me).get('/api/users/discover');
  assert.strictEqual(r.body.profiles[0].id, match.id);
  assert.ok(r.body.profiles[0].compat > r.body.profiles[1].compat);
  await h.db.query(`INSERT INTO boosts (user_id, ends_at) VALUES ($1, NOW() + INTERVAL '20 minutes')`, [meh.id]);
  r = await h.as(me).get('/api/users/discover');
  assert.strictEqual(r.body.profiles[0].id, meh.id, 'active boost takes priority');
  assert.strictEqual(r.body.profiles[0].boosted, true);
});

test('advanced filters are Plus-gated (402) and work once entitled; basic age/distance stay free', async () => {
  await h.resetDb();
  const me = await h.createUser({ gender: 'man' });
  const tall = await h.createUser({ gender: 'woman', height_cm: 175, relationship_intent: 'marriage' });
  const short = await h.createUser({ gender: 'woman', height_cm: 155, relationship_intent: 'friends' });
  let r = await h.as(me).get('/api/users/discover?heightMin=170');
  assert.strictEqual(r.status, 402); assert.strictEqual(r.body.code, 'upgrade_required');
  assert.strictEqual((await h.as(me).get('/api/users/discover?verifiedOnly=true')).status, 402);
  assert.strictEqual((await h.as(me).get('/api/users/discover?ageMin=20&ageMax=40&distanceKm=100')).status, 200);
  await h.setUser(me.id, { plan: 'plus', plan_expires_at: new Date(Date.now() + 864e5) }); await fresh(me);
  assert.deepStrictEqual(idsOf(await h.as(me).get('/api/users/discover?heightMin=170')), [tall.id]);
  assert.deepStrictEqual(idsOf(await h.as(me).get('/api/users/discover?intent=friends')), [short.id]);
  await h.setUser(me.id, { plan_expires_at: new Date(Date.now() - 1000) }); await fresh(me);
  assert.strictEqual((await h.as(me).get('/api/users/discover?heightMin=170')).status, 402, 'expired plan loses entitlements');
});

test('cursor pagination has no duplicates and rejects garbage cursors', async () => {
  await h.resetDb();
  const me = await h.createUser({ gender: 'man' });
  for (let i = 0; i < 23; i++) await h.createUser({ gender: 'woman' });
  const seen = []; let cursor = null;
  do {
    const r = await h.as(me).get(`/api/users/discover?limit=7${cursor ? '&cursor=' + cursor : ''}`);
    seen.push(...idsOf(r)); cursor = r.body.nextCursor;
  } while (cursor);
  assert.strictEqual(seen.length, 23); assert.strictEqual(new Set(seen).size, 23);
  assert.strictEqual((await h.as(me).get('/api/users/discover?cursor=@@@')).status, 400);
});

test('daily recommendations are stable, size-limited and re-filtered at read time', async () => {
  await h.resetDb();
  const me = await h.createUser({ gender: 'man' });
  const cands = []; for (let i = 0; i < 14; i++) cands.push(await h.createUser({ gender: 'woman' }));
  const a = await h.as(me).get('/api/users/recommendations');
  assert.strictEqual(a.status, 200); assert.strictEqual(a.body.profiles.length, 10, 'free: one batch of 10');
  const b = await h.as(me).get('/api/users/recommendations');
  assert.deepStrictEqual(b.body.profiles.map((p) => p.id), a.body.profiles.map((p) => p.id), 'stable through the day');
  await h.db.query('INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1,$2)', [me.id, a.body.profiles[0].id]);
  const c = await h.as(me).get('/api/users/recommendations');
  assert.ok(!c.body.profiles.some((p) => p.id === a.body.profiles[0].id), 'blocked user disappears from picks');
  const more = await h.as(me).post('/api/users/recommendations/refresh');
  assert.strictEqual(more.status, 402, 'free users have a single batch');
});

test('likes-you: count for free users, full list for Premium; who-viewed likewise; incognito hides viewing', async () => {
  await h.resetDb();
  const me = await h.createUser({ gender: 'man' });
  const fans = []; for (let i = 0; i < 3; i++) { const f = await h.createUser({ gender: 'woman' }); fans.push(f); await h.db.query(`INSERT INTO swipes (swiper_id, target_id, action) VALUES ($1,$2,'like')`, [f.id, me.id]); }
  let r = await h.as(me).get('/api/users/likes-you');
  assert.deepStrictEqual([r.body.locked, r.body.count, r.body.profiles.length], [true, 3, 0]);
  await h.setUser(me.id, { plan: 'premium', plan_expires_at: new Date(Date.now() + 864e5) }); await fresh(me);
  r = await h.as(me).get('/api/users/likes-you');
  assert.deepStrictEqual([r.body.locked, r.body.profiles.length], [false, 3]);
  await h.as(fans[0]).get(`/api/users/${me.id}`);
  const proFan = fans[1]; await h.setUser(proFan.id, { plan: 'pro', plan_expires_at: new Date(Date.now() + 864e5), incognito: true }); await fresh(proFan);
  await h.as(proFan).get(`/api/users/${me.id}`);
  const v = await h.as(me).get('/api/users/viewers');
  assert.deepStrictEqual(v.body.viewers.map((x) => x.id), [fans[0].id], 'incognito viewer is not recorded');
});
