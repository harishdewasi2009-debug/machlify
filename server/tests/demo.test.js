const test = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');
const cfg = require('../config');
const { seedDemo, deleteDemo } = require('../scripts/seed-demo');
const random = require('../services/randomTalk');
const { request, app } = h;

let viewer;
test.before(async () => {
  await h.setup();
  await seedDemo({ query: (t, p) => h.db.query(t, p) }, { count: 60, female: 30 });
  viewer = await h.createUser({ gender: 'man', pref_genders: [], pref_age_min: 18, pref_age_max: 60, pref_distance_km: 5000, lat: null, lng: null, location: '', country: '' });
  await h.createUser({ gender: 'woman' }); // one real candidate
  await h.setUser(viewer.id, { plan: 'premium', plan_expires_at: new Date(Date.now() + 864e5) });
  viewer.token = require('../services/tokens').signAccess(await h.fresh(viewer.id));
});
test.after(h.teardown);

const ids = async (path) => (await h.as(viewer).get(path)).body;
const withEnv = async (env, fn) => {
  const old = {}; for (const k of Object.keys(env)) { old[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  try { return await fn(); } finally { for (const k of Object.keys(old)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } }
};

test('demo profiles are hidden by default (DEMO_MODE off)', async () => {
  const b = await ids('/api/users/discover?limit=50');
  assert.ok(b.profiles.length >= 1 && b.profiles.every((p) => !p.isDemo));
});

test('DEMO_MODE=true in development shows demo profiles, each flagged isDemo', async () => {
  await withEnv({ DEMO_MODE: 'true', NODE_ENV: 'development' }, async () => {
    const b = await ids('/api/users/discover?limit=50');
    assert.ok(b.profiles.some((p) => p.isDemo), 'demo profiles visible in dev');
    assert.ok(b.profiles.filter((p) => p.isDemo).every((p) => p.photos[0].startsWith('/demo-avatars/')));
  });
});

test('PRODUCTION isolation: zero demo rows from EVERY listing path even with DEMO_MODE=true', async () => {
  await withEnv({ DEMO_MODE: 'true', NODE_ENV: 'production' }, async () => {
    const demoIds = (await h.db.query('SELECT id FROM users WHERE is_demo')).rows.map((r) => r.id);
    // make demo users like the viewer so likes-you has candidates
    for (const d of demoIds.slice(0, 5)) await h.db.query(`INSERT INTO swipes (swiper_id, target_id, action) VALUES ($1,$2,'like') ON CONFLICT DO NOTHING`, [d, viewer.id]);
    const paths = ['/api/users/discover?limit=50', '/api/users/discover?mode=global&limit=50', '/api/users/discover?mode=new&limit=50', '/api/users/discover?mode=verified&limit=50',
                   '/api/users/discover?mode=active&limit=50', '/api/users/discover?mode=interests&limit=50', '/api/users/likes-you', '/api/users/recommendations'];
    for (const p of paths) {
      const r = await h.as(viewer).get(p);
      assert.ok([200, 400].includes(r.status), p + ' ' + r.status);
      const all = JSON.stringify(r.body);
      assert.ok(!all.includes('"isDemo":true') && !all.includes('demo-avatars'), `demo profile leaked from ${p}`);
    }
    for (const d of demoIds.slice(0, 3)) assert.strictEqual((await h.as(viewer).get('/api/users/' + d)).status, 404, 'direct profile fetch of a demo user');
    const swipe = await h.as(viewer).post('/api/swipes', { targetId: demoIds[0], action: 'like' });
    assert.strictEqual(swipe.status, 404, 'cannot swipe on a demo profile in production');
  });
});

test('demo accounts cannot log in (no password) and cannot join Random Talk', async () => {
  const d = (await h.db.query('SELECT * FROM users WHERE is_demo LIMIT 1')).rows[0];
  assert.strictEqual(d.password_hash, null);
  assert.strictEqual((await request(app).post('/api/auth/login').send({ email: d.email, password: 'password123' })).status, 401);
  await assert.rejects(random.join({ ...d, random_rules_accepted_at: new Date() }), /Demo profiles/);
});

test('guest /auth/demo session exists only outside production and only with DEMO_MODE', async () => {
  assert.strictEqual((await request(app).post('/api/auth/demo')).status, 403);
  await withEnv({ DEMO_MODE: 'true', NODE_ENV: 'development' }, async () => assert.strictEqual((await request(app).post('/api/auth/demo')).status, 200));
  await withEnv({ DEMO_MODE: 'true', NODE_ENV: 'production' }, async () => assert.strictEqual((await request(app).post('/api/auth/demo')).status, 403));
});

test('the server refuses to boot in production with DEMO_MODE=true, weak secrets, mock verification or dev payments', async () => {
  const bad = (env) => withEnv(env, async () => assert.throws(() => cfg.assertProductionSafe(), /Unsafe production configuration/));
  const good = { NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(48), REFRESH_SECRET: 'y'.repeat(48), APP_ORIGIN: 'https://m.example.com', VERIFICATION_PROVIDER: 'persona', VERIFICATION_WEBHOOK_SECRET: 'abc', DEMO_MODE: undefined, PAYMENTS_DEV_MODE: undefined, REQUIRE_AGE_VERIFICATION: undefined };
  await withEnv(good, async () => assert.doesNotThrow(() => cfg.assertProductionSafe()));
  await bad({ ...good, DEMO_MODE: 'true' });
  await bad({ ...good, JWT_SECRET: 'change-this-to-a-long-random-string-at-least-32-chars' });
  await bad({ ...good, VERIFICATION_PROVIDER: 'mock' });
  await bad({ ...good, REQUIRE_AGE_VERIFICATION: 'false' });
  await bad({ ...good, PAYMENTS_DEV_MODE: 'true' });
  await bad({ ...good, APP_ORIGIN: undefined });
});

test('seeding is refused in production; deletion removes every demo row and dependents', async () => {
  const db = { query: (t, p) => h.db.query(t, p) };
  await withEnv({ NODE_ENV: 'production' }, async () => assert.rejects(seedDemo(db, { count: 5 }), /Refusing/));
  await assert.rejects(seedDemo(db, { count: 5 }), /already exist/);
  const real = Number((await h.db.query('SELECT COUNT(*) c FROM users WHERE NOT is_demo')).rows[0].c);
  assert.strictEqual(await deleteDemo(db), 60);
  const left = await h.db.query(`SELECT (SELECT COUNT(*) FROM users WHERE is_demo) u, (SELECT COUNT(*) FROM photos WHERE moderation->>'demo'='true') p`);
  assert.deepStrictEqual([left.rows[0].u, left.rows[0].p], ['0', '0']);
  assert.strictEqual(Number((await h.db.query('SELECT COUNT(*) c FROM users WHERE NOT is_demo')).rows[0].c), real, 'real users untouched');
});
