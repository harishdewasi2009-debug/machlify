// Versioned SQL migrations. Files in ./migrations run in filename order, each
// inside its own transaction, and are recorded in schema_migrations.
// A Postgres advisory lock stops two instances migrating at once.
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'migrations');
const LOCK_KEY = 727272;

async function migrate(pool, { log = console.log } = {}) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`);
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map(r => r.name));
    const files = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort();
    const applied = [];
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(DIR, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
        log(`migration applied: ${file}`);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        err.message = `Migration ${file} failed: ${err.message}`;
        throw err;
      }
    }
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    client.release();
  }
}

module.exports = { migrate };

if (require.main === module) {
  require('dotenv').config();
  const { pool } = require('./db');
  migrate(pool)
    .then((a) => { console.log(a.length ? `Applied ${a.length} migration(s).` : 'Database already up to date.'); return pool.end(); })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
