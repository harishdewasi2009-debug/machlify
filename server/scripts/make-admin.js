#!/usr/bin/env node
// Usage: npm run make-admin -- someone@example.com [admin|moderator|user]
require('dotenv').config();
const { pool } = require('../db');
(async () => {
  const [email, role = 'admin'] = process.argv.slice(2);
  if (!email || !['admin', 'moderator', 'user'].includes(role)) { console.error('Usage: make-admin <email> [admin|moderator|user]'); process.exit(1); }
  const r = await pool.query('UPDATE users SET role=$2 WHERE email=$1 RETURNING id, email, role', [email.toLowerCase(), role]);
  console.log(r.rows[0] ? `OK: ${r.rows[0].email} is now ${r.rows[0].role}. Set up 2FA from the /admin page.` : 'No user with that email.');
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
