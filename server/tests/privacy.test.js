const test = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');

test.before(h.setup);
test.after(h.teardown);

const FORBIDDEN_KEYS = new Set(['email', 'phone', 'lat', 'lng', 'latitude', 'longitude', 'dob', 'role', 'risk_score', 'risk_level', 'riskscore', 'risklevel', 'google_id', 'googleid', 'signup_ip', 'token_version']);
const FORBIDDEN_SUBSTR = ['password', 'secret', 'totp', 'token'];

function assertClean(obj, where) {
  const walk = (o, path) => {
    if (Array.isArray(o)) return o.forEach((x, i) => walk(x, `${path}[${i}]`));
    if (o && typeof o === 'object') {
      for (const [k, v] of Object.entries(o)) {
        const lk = k.toLowerCase();
        assert.ok(!FORBIDDEN_KEYS.has(lk) && !FORBIDDEN_SUBSTR.some((f) => lk.includes(f)), `${where}: leaked field "${path}.${k}"`);
        walk(v, `${path}.${k}`);
      }
    }
  };
  walk(obj, where);
}

test('no endpoint leaks another user’s email, phone, coordinates, DOB or internals', async () => {
  const me = await h.createUser({ gender: 'man' });
  const other = await h.createUser({ gender: 'woman', phone: '+919999999999', phone_verified_at: new Date(), email: 'secret-other@example.com' });
  const liker = await h.createUser({ gender: 'woman' });
  await h.db.query(`INSERT INTO swipes (swiper_id, target_id, action) VALUES ($1,$2,'like')`, [liker.id, me.id]);
  await h.makeMatch(me, other);
  await h.db.query(`INSERT INTO profile_views (viewer_id, viewed_id) VALUES ($1,$2)`, [other.id, me.id]);
  await h.setUser(me.id, { plan: 'premium', plan_expires_at: new Date(Date.now() + 864e5) });
  const meFresh = await h.fresh(me.id); me.token = require('../services/tokens').signAccess(meFresh);

  const calls = [
    ['discover', await h.as(me).get('/api/users/discover')],
    ['matches', await h.as(me).get('/api/matches')],
    ['profile', await h.as(me).get(`/api/users/${other.id}`)],
    ['likes-you', await h.as(me).get('/api/users/likes-you')],
    ['viewers', await h.as(me).get('/api/users/viewers')],
    ['recommendations', await h.as(me).get('/api/users/recommendations')],
  ];
  for (const [name, r] of calls) { assert.strictEqual(r.status, 200, name + ' ' + JSON.stringify(r.body)); assertClean(r.body, name); }
  const raw = JSON.stringify(calls.map((c) => c[1].body));
  assert.ok(!raw.includes('secret-other@example.com') && !raw.includes('9999999999'));
  // …but a user does see their own email
  assert.strictEqual((await h.as(me).get('/api/auth/me')).body.user.email, me.email);
});

test('distance is shown only as a coarse band and can be hidden', async () => {
  const me = await h.createUser({ gender: 'man' });
  const near = await h.createUser({ gender: 'woman', lat: 19.09, lng: 72.89 });
  const hidden = await h.createUser({ gender: 'woman', lat: 19.10, lng: 72.90, show_distance: false });
  const r = await h.as(me).get('/api/users/discover?limit=50');
  const a = r.body.profiles.find((p) => p.id === near.id), b = r.body.profiles.find((p) => p.id === hidden.id);
  assert.ok([2, 5, 10].includes(a.distanceKm), 'banded, not exact: ' + a.distanceKm);
  assert.strictEqual(b.distanceKm, undefined);
});

test('coordinates are coarsened before storage', async () => {
  const u = await h.createUser({ lat: null, lng: null });
  const r = await h.as(u).put('/api/users/me/location', { lat: 12.971598, lng: 77.594562 });
  assert.strictEqual(r.status, 200);
  const row = await h.fresh(u.id);
  assert.strictEqual(row.lat, 12.97); assert.strictEqual(row.lng, 77.59);
  assert.strictEqual((await h.as(u).put('/api/users/me/location', { lat: 999, lng: 1 })).status, 400);
});

test('online status and last-active can be hidden', async () => {
  const me = await h.createUser({ gender: 'man' });
  const shy = await h.createUser({ gender: 'woman', is_online: true, show_online: false });
  const open = await h.createUser({ gender: 'woman', is_online: true, show_online: true });
  const r = await h.as(me).get('/api/users/discover?limit=50');
  const s = r.body.profiles.find((p) => p.id === shy.id), o = r.body.profiles.find((p) => p.id === open.id);
  assert.strictEqual(s.online, false); assert.strictEqual(s.lastActive, null);
  assert.strictEqual(o.online, true);
});
