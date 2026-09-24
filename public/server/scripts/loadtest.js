#!/usr/bin/env node
// Load test against a RUNNING server (never production).
//   1) NODE_ENV=development DEMO_MODE=true npm start        (same DATABASE_URL / JWT_SECRET as below)
//   2) npm run seed:demo                                     (900 demo profiles)
//   3) npm run loadtest -- --users=200 --duration=30 --base=http://localhost:4000
// Creates synthetic verified accounts directly in the DB (removed at the end unless --keep),
// then drives discovery paging, swipes, match listing and paired realtime chat concurrently.
require('dotenv').config();
const { io } = require('socket.io-client');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const tokens = require('../services/tokens');

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v === undefined ? true : v]; }));
const BASE = args.base || 'http://localhost:4000';
const N = parseInt(args.users, 10) || 100;
const DURATION = (parseInt(args.duration, 10) || 20) * 1000;
const P95_LIMIT = parseInt(args.p95 || '800', 10);

if (process.env.NODE_ENV === 'production') { console.error('Refusing to run a load test with NODE_ENV=production.'); process.exit(1); }

const lat = {}; const errs = {}; let total = 0;
const rec = (name, ms, ok) => { (lat[name] = lat[name] || []).push(ms); total++; if (!ok) errs[name] = (errs[name] || 0) + 1; };
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))] || 0; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(name, token, method, path, body, okStatuses = [200, 201]) {
  const t0 = performance.now();
  try {
    const res = await fetch(BASE + path, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const ok = okStatuses.includes(res.status) || res.status === 429;      // 429 = rate/quota limit working as designed
    const json = await res.json().catch(() => ({}));
    rec(name, performance.now() - t0, ok); return { status: res.status, json };
  } catch (e) { rec(name, performance.now() - t0, false); return { status: 0, json: {} }; }
}

async function main() {
  const hash = bcrypt.hashSync('loadtest-pass', 4);
  const users = [];
  const tag = 'lt' + Date.now();
  for (let i = 0; i < N; i++) {
    const g = i % 2 ? 'man' : 'woman';
    const r = await pool.query(
      `INSERT INTO users (email, password_hash, name, dob, age, gender, pref_genders, bio, location, country, lat, lng, interests, interest_tags, photos, verification_status, over_18, tos_accepted_at, last_active_at, profile_strength)
       VALUES ($1,$2,$3,'1996-01-01',30,$4,'{}','Load test user','Mumbai','India',19.08,72.88,'["Travel","Music"]','{travel,music}','[]','verified',true,NOW(),NOW(),60) RETURNING *`,
      [`${tag}-${i}@loadtest.invalid`, hash, 'LT' + i, g]);
    const u = r.rows[0];
    for (let p = 0; p < 2; p++) await pool.query(`INSERT INTO photos (user_id, url, thumb_url, position, status) VALUES ($1,'/demo-avatars/lorelei/lt.svg','/demo-avatars/lorelei/lt.svg',$2,'approved')`, [u.id, p]);
    await pool.query(`UPDATE users SET photos='[{"url":"/demo-avatars/lorelei/lt.svg"},{"url":"/demo-avatars/lorelei/lt.svg"}]' WHERE id=$1`, [u.id]);
    users.push({ id: u.id, token: tokens.signAccess(u) });
  }
  // chat pairs
  const pairs = [];
  for (let i = 0; i + 1 < users.length; i += 2) {
    const [a, b] = users[i].id < users[i + 1].id ? [users[i], users[i + 1]] : [users[i + 1], users[i]];
    const m = await pool.query(`INSERT INTO matches (user_a, user_b, source) VALUES ($1,$2,'swipe') RETURNING id`, [a.id, b.id]);
    pairs.push({ matchId: m.rows[0].id, a: users[i], b: users[i + 1] });
  }
  console.log(`Created ${users.length} synthetic users, ${pairs.length} chat pairs. Running ${DURATION / 1000}s against ${BASE} ...`);

  const stop = Date.now() + DURATION; let sockets = 0, msgsSent = 0, msgsRecv = 0, socketErrors = 0;
  const browse = async (u) => {
    let cursor = null;
    while (Date.now() < stop) {
      const r = await call('GET /discover', u.token, 'GET', `/api/users/discover?limit=20${cursor ? '&cursor=' + cursor : ''}`);
      cursor = r.json.nextCursor || null;
      for (const p of (r.json.profiles || []).slice(0, 3)) {
        await call('POST /swipes', u.token, 'POST', '/api/swipes', { targetId: p.id, action: Math.random() < 0.15 ? 'like' : 'pass' }, [200, 201, 409, 404]);
      }
      if (Math.random() < 0.3) await call('GET /matches', u.token, 'GET', '/api/matches');
      if (Math.random() < 0.1) await call('GET /recommendations', u.token, 'GET', '/api/users/recommendations');
      await sleep(50 + Math.random() * 150);
    }
  };
  const chat = async (pair) => {
    const open = (u) => new Promise((resolve) => { const s = io(BASE, { auth: { token: u.token }, transports: ['websocket'], reconnection: false, forceNew: true }); s.on('connect', () => { sockets++; resolve(s); }); s.on('connect_error', () => { socketErrors++; resolve(null); }); });
    const [sa, sb] = await Promise.all([open(pair.a), open(pair.b)]);
    if (!sa || !sb) return;
    sb.on('message:new', () => { msgsRecv++; });
    while (Date.now() < stop) {
      const t0 = performance.now();
      const ack = await new Promise((resolve) => { const to = setTimeout(() => resolve(null), 3000); sa.emit('message:send', { matchId: pair.matchId, text: 'load test message ' + Math.random().toString(36).slice(2, 8) }, (r) => { clearTimeout(to); resolve(r); }); });
      rec('WS message:send ack', performance.now() - t0, !!(ack && (ack.ok || ack.code === 'rate_limited' || ack.status === 429))); if (ack && ack.ok) msgsSent++;
      await sleep(1500 + Math.random() * 1500);
    }
    sa.close(); sb.close();
  };
  await Promise.all([...users.map(browse), ...pairs.map(chat)]);

  console.log('\nEndpoint                    count    p50     p95     p99    errors');
  let worst = 0;
  for (const [name, arr] of Object.entries(lat)) {
    const p95 = pct(arr, 0.95); worst = Math.max(worst, p95);
    console.log(`${name.padEnd(26)} ${String(arr.length).padStart(6)} ${pct(arr, 0.5).toFixed(0).padStart(6)}ms ${p95.toFixed(0).padStart(6)}ms ${pct(arr, 0.99).toFixed(0).padStart(6)}ms ${String(errs[name] || 0).padStart(7)}`);
  }
  const totalErrs = Object.values(errs).reduce((a, b) => a + b, 0);
  console.log(`\nRequests: ${total}  errors: ${totalErrs} (${((totalErrs / Math.max(1, total)) * 100).toFixed(2)}%)  sockets: ${sockets}  socket errors: ${socketErrors}  messages sent/received: ${msgsSent}/${msgsRecv}`);
  if (!args.keep) { await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`${tag}-%@loadtest.invalid`]); console.log('Removed synthetic users.'); }
  await pool.end();
  const failed = totalErrs / Math.max(1, total) > 0.01 || worst > P95_LIMIT || socketErrors > 0;
  console.log(failed ? `RESULT: FAIL (error rate > 1%, p95 > ${P95_LIMIT}ms, or socket errors)` : 'RESULT: PASS');
  process.exit(failed ? 1 : 0);
}
main().catch(async (e) => { console.error(e); await pool.end().catch(() => {}); process.exit(1); });
