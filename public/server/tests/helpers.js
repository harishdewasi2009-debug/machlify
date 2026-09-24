process.env.NODE_ENV = 'test';
process.env.UPLOAD_DIR = require('path').join(require('os').tmpdir(), 'matchify-test-uploads');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/matchify_test';
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123';
process.env.REFRESH_SECRET = 'test-refresh-test-refresh-test-refresh';
process.env.RATE_LIMIT_DISABLED = 'true';
process.env.DISABLE_JOBS = 'true';
process.env.VERIFICATION_WEBHOOK_SECRET = 'whsec_verification_test';
process.env.VERIFICATION_PROVIDER = 'mock';
process.env.RAZORPAY_KEY_ID = 'rzp_test_key';
process.env.RAZORPAY_KEY_SECRET = 'rzp_test_secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'whsec_razorpay_test';
delete process.env.DEMO_MODE; delete process.env.ANTHROPIC_API_KEY; delete process.env.REQUIRE_STAFF_2FA;

const http = require('http');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const { io: ioClient } = require('socket.io-client');
const db = require('../db');
const { createApp } = require('../app');
const tokens = require('../services/tokens');
const { refreshProfile } = require('../services/profile');

const app = createApp();
let counter = 0;
const PW = 'password123';
const PW_HASH = bcrypt.hashSync(PW, 4);

async function setup() { await db.init({ quiet: true, log: () => {} }); await resetDb(); }
async function resetDb() {
  const { rows } = await db.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> 'schema_migrations'`);
  await db.query(`TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
  require('../services/randomTalk').reset();
}
async function teardown() { await db.pool.end(); }

// Insert a fully verified, discoverable user directly (fast). Override any column via `o`.
async function createUser(o = {}) {
  const n = ++counter;
  const gender = o.gender || (n % 2 ? 'woman' : 'man');
  const interests = o.interests || ['travel', 'coffee', 'music'];
  const cols = {
    email: `user${n}@example.com`, password_hash: PW_HASH, auth_provider: 'local', name: `User${n}`,
    dob: '1996-06-15', age: 30, gender, interested_in: 'everyone', pref_genders: [], bio: 'I like long walks, good food and honest conversations.',
    job: 'Engineer', location: 'Mumbai', country: 'India', lat: 19.08, lng: 72.88,
    interests: JSON.stringify(interests.map((s) => s[0].toUpperCase() + s.slice(1))), interest_tags: interests.map((s) => s.toLowerCase()),
    photos: '[]', verification_status: 'verified', over_18: true, tos_accepted_at: new Date(), email_verified_at: new Date(),
    last_active_at: new Date(), relationship_intent: 'long_term',
    ...o,
  };
  delete cols.noPhotos; delete cols.photoCount;
  const keys = Object.keys(cols);
  const { rows } = await db.query(`INSERT INTO users (${keys.join(',')}) VALUES (${keys.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING *`, keys.map((k) => cols[k]));
  let user = rows[0];
  if (o.noPhotos !== true) {
    for (let i = 0; i < (o.photoCount ?? 2); i++) await db.query(`INSERT INTO photos (user_id, url, thumb_url, position, status) VALUES ($1,$2,$2,$3,'approved')`, [user.id, `/uploads/test/${user.id}-${i}.jpg`, i]);
    await refreshProfile(user.id);
    user = (await db.query('SELECT * FROM users WHERE id=$1', [user.id])).rows[0];
  }
  return { user, id: user.id, token: tokens.signAccess(user), email: user.email };
}
const authed = (token) => ({
  get: (u) => request(app).get(u).set('Authorization', 'Bearer ' + token),
  post: (u, b) => request(app).post(u).set('Authorization', 'Bearer ' + token).send(b || {}),
  put: (u, b) => request(app).put(u).set('Authorization', 'Bearer ' + token).send(b || {}),
  delete: (u, b) => request(app).delete(u).set('Authorization', 'Bearer ' + token).send(b || {}),
});
const as = (u) => authed(u.token);
const fresh = async (id) => (await db.query('SELECT * FROM users WHERE id=$1', [id])).rows[0];
const setUser = (id, fields) => { const k = Object.keys(fields); return db.query(`UPDATE users SET ${k.map((c, i) => `${c}=$${i + 2}`).join(',')} WHERE id=$1`, [id, ...k.map((c) => fields[c])]); };

async function makeMatch(a, b, source = 'swipe') {
  const [x, y] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
  const { rows } = await db.query(`INSERT INTO matches (user_a, user_b, source) VALUES ($1,$2,$3) RETURNING *`, [x, y, source]);
  return rows[0];
}

// ---- sockets ----
async function startServer() {
  const server = http.createServer(app);
  const io = require('../socket').attachSocket(server);
  await new Promise((r) => server.listen(0, r));
  const url = `http://localhost:${server.address().port}`;
  const sockets = [];
  return {
    url,
    connect(token) {
      return new Promise((resolve, reject) => {
        const s = ioClient(url, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true });
        sockets.push(s);
        s.on('connect', () => resolve(s)); s.on('connect_error', (e) => reject(e));
      });
    },
    async close() { sockets.forEach((s) => s.close()); io.close(); await new Promise((r) => server.close(r)); },
  };
}
const emit = (socket, event, payload) => new Promise((resolve) => socket.emit(event, payload, (r) => resolve(r)));
const waitFor = (socket, event, ms = 2000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
  socket.once(event, (p) => { clearTimeout(t); resolve(p); });
});
const expectNo = (socket, event, ms = 400) => new Promise((resolve, reject) => {
  const h = () => reject(new Error(`unexpected ${event}`));
  socket.once(event, h); setTimeout(() => { socket.off(event, h); resolve(); }, ms);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { app, request, db, setup, resetDb, teardown, createUser, authed, as, fresh, setUser, makeMatch, startServer, emit, waitFor, expectNo, sleep, PW };
