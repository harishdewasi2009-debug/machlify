const test = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');
const { migrate } = require('../migrate');

test('fresh empty database migrates cleanly (reports/matches ordering bug fixed) and is idempotent', async () => {
  await h.db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const applied = await migrate(h.db.pool, { log: () => {} });
  assert.ok(applied.length >= 6, 'all migrations applied on an empty DB');
  const again = await migrate(h.db.pool, { log: () => {} });
  assert.deepStrictEqual(again, [], 'second run applies nothing');
  for (const t of ['users', 'matches', 'reports', 'photos', 'random_sessions', 'payments', 'entitlement_grants', 'audit_log']) {
    const r = await h.db.query('SELECT to_regclass($1) AS t', [t]);
    assert.ok(r.rows[0].t, `table ${t} exists`);
  }
  const age = await h.db.query(`SELECT mf_age('2000-01-01'::date, 5) a, mf_age(NULL, 33) b, mf_distance_km(19.07,72.87,28.61,77.20) d`);
  assert.ok(age.rows[0].a >= 25); assert.strictEqual(age.rows[0].b, 33);
  assert.ok(age.rows[0].d > 1100 && age.rows[0].d < 1250, 'Mumbai→Delhi ≈ 1150 km');
});

test('audit_log is append-only', async () => {
  await h.setup();
  await h.db.query(`INSERT INTO audit_log (action) VALUES ('x')`);
  await assert.rejects(h.db.query(`UPDATE audit_log SET action='y'`), /append-only/);
  await assert.rejects(h.db.query(`DELETE FROM audit_log`), /append-only/);
});

test.after(h.teardown);
