const test = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');
const { seedDemo, deleteDemo } = require('../scripts/seed-demo');
const { generateProfiles } = require('../lib/demoData');
const { CITIES } = require('../lib/cities');

const db = { query: (t, p) => h.db.query(t, p) };
test.before(h.setup);
test.after(h.teardown);

test('generator is deterministic and produces 18+ fictional profiles only', () => {
  const a = generateProfiles({ count: 900, seed: 1 }), b = generateProfiles({ count: 900, seed: 1 }), c = generateProfiles({ count: 900, seed: 2 });
  assert.deepStrictEqual(a, b); assert.notDeepStrictEqual(a, c);
  assert.ok(a.every((p) => p.age >= 18 && p.age <= 45));
  assert.ok(a.every((p) => p.email.endsWith('@demo.matchify.invalid')));
  assert.ok(a.every((p) => !/https?:|www\.|@|\d{10}/.test(p.bio)), 'no links/contacts in bios');
  assert.ok(a.every((p) => p.photos.every((u) => u.startsWith('/demo-avatars/'))), 'avatars are local illustrations, never scraped photos');
});

test('npm run seed:demo equivalent: exactly 900 profiles, 450/450, Indian city spread, 18+, unloginable', async () => {
  const t0 = Date.now();
  const r = await seedDemo(db, { count: 900 });
  assert.strictEqual(r.created, 900); assert.ok(Date.now() - t0 < 15000, 'seeds in seconds');
  const q = await h.db.query(`SELECT COUNT(*) n, COUNT(*) FILTER (WHERE gender='woman') w, COUNT(*) FILTER (WHERE gender='man') m,
      MIN(mf_age(dob, age)) minage, COUNT(DISTINCT location) cities, COUNT(*) FILTER (WHERE password_hash IS NOT NULL) pw,
      COUNT(*) FILTER (WHERE country <> 'India') foreign_c, COUNT(*) FILTER (WHERE email NOT LIKE '%@demo.matchify.invalid') bad_email,
      COUNT(*) FILTER (WHERE NOT is_demo) not_demo FROM users`);
  const x = q.rows[0];
  assert.deepStrictEqual([x.n, x.w, x.m], ['900', '450', '450']);
  assert.ok(x.minage >= 18); assert.ok(Number(x.cities) >= 20, 'many cities: ' + x.cities);
  assert.deepStrictEqual([x.pw, x.foreign_c, x.bad_email, x.not_demo], ['0', '0', '0', '0']);
  const cities = new Set(CITIES.map((c) => c.name));
  assert.ok((await h.db.query('SELECT DISTINCT location FROM users')).rows.every((r) => cities.has(r.location)));
  const ages = (await h.db.query('SELECT COUNT(DISTINCT mf_age(dob, age)) n FROM users')).rows[0].n; assert.ok(Number(ages) >= 15, 'varied ages');
  assert.strictEqual((await h.db.query('SELECT COUNT(DISTINCT bio) n FROM users')).rows[0].n >= 800, true, 'varied bios');
  const noInteractions = await h.db.query(`SELECT (SELECT COUNT(*) FROM swipes) s, (SELECT COUNT(*) FROM matches) m, (SELECT COUNT(*) FROM messages) g`);
  assert.deepStrictEqual(Object.values(noInteractions.rows[0]), ['0', '0', '0'], 'seed never fabricates likes/matches/messages');
});

test('--delete removes all 900 and every dependent row; --reset style re-seed works', async () => {
  assert.strictEqual(await deleteDemo(db), 900);
  const left = await h.db.query(`SELECT (SELECT COUNT(*) FROM users) u, (SELECT COUNT(*) FROM photos) p, (SELECT COUNT(*) FROM profile_prompts) pr`);
  assert.deepStrictEqual(Object.values(left.rows[0]), ['0', '0', '0']);
  assert.strictEqual((await seedDemo(db, { count: 120, female: 60 })).created, 120);
  assert.strictEqual(await deleteDemo(db), 120);
});

test('dry run writes nothing', async () => {
  const r = await seedDemo(db, { count: 50, dryRun: true });
  assert.strictEqual(r.wouldCreate, 50);
  assert.strictEqual((await h.db.query('SELECT COUNT(*) c FROM users')).rows[0].c, '0');
});

test('900 demo profiles support discovery pagination end-to-end (cursor, no duplicates)', async () => {
  await seedDemo(db, { count: 900 });
  const viewer = await h.createUser({ gender: 'man', pref_distance_km: 3000, lat: 19.08, lng: 72.88, plan: 'free' });
  await h.setUser(viewer.id, { pref_genders: [], pref_age_min: 18, pref_age_max: 60 });
  process.env.DEMO_MODE = 'true'; process.env.NODE_ENV = 'development';
  try {
    const seen = new Set(); let cursor = null; let pages = 0;
    do {
      const r = await h.as(viewer).get(`/api/users/discover?limit=50${cursor ? '&cursor=' + cursor : ''}`);
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      for (const p of r.body.profiles) { assert.ok(!seen.has(p.id), 'duplicate ' + p.id); seen.add(p.id); }
      cursor = r.body.nextCursor; pages++;
    } while (cursor && pages < 40);
    assert.ok(seen.size > 250, 'paginated through demo pool: ' + seen.size + ' profiles in ' + pages + ' pages');
  } finally { delete process.env.DEMO_MODE; process.env.NODE_ENV = 'test'; }
});
