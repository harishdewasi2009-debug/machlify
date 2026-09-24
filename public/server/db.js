require('dotenv').config();
const { Pool } = require('pg');
const { migrate } = require('./migrate');

if (!process.env.DATABASE_URL) {
  console.error('Missing DATABASE_URL in environment (.env file). Set it to your Postgres connection string.');
  process.exit(1);
}

// Render's managed Postgres needs SSL; local Postgres usually doesn't.
const useSSL = process.env.DATABASE_URL.includes('render.com') || process.env.PGSSL === 'true';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
  max: parseInt(process.env.PG_POOL_MAX || '10', 10),
});
pool.on('error', (err) => console.error('Unexpected Postgres pool error', err.message));

const query = (text, params) => pool.query(text, params);
async function one(text, params) { const { rows } = await pool.query(text, params); return rows[0] || null; }
async function many(text, params) { const { rows } = await pool.query(text, params); return rows; }

// Run fn(client) in a transaction.
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function init(opts = {}) {
  const applied = await migrate(pool, opts);
  if (applied.length && !opts.quiet) console.log('Database schema ready (PostgreSQL).');
}

module.exports = { pool, query, one, many, tx, init };
