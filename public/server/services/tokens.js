// Access (short-lived JWT) + refresh (opaque, hashed at rest, httpOnly cookie) tokens.
const jwt = require('jsonwebtoken');
const { one, query } = require('../db');
const { ACCESS_TOKEN_TTL, REFRESH_TTL_DAYS, isProd } = require('../config');
const { randomToken, sha256, clientIp, deviceHash } = require('../lib/util');

const COOKIE = 'mf_rt';

const signAccess = (user) => jwt.sign({ userId: user.id, tv: user.token_version || 0 }, process.env.JWT_SECRET, { expiresIn: ACCESS_TOKEN_TTL });

function cookieOpts() {
  return { httpOnly: true, sameSite: 'lax', secure: isProd(), path: '/api/auth', maxAge: REFRESH_TTL_DAYS * 86400 * 1000 };
}

async function issueSession(req, res, user) {
  const raw = randomToken(48);
  await query(
    `INSERT INTO sessions (user_id, token_hash, ip, user_agent, geo_country, device_hash, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6, NOW() + ($7 || ' days')::interval)`,
    [user.id, sha256(raw), clientIp(req), (req.headers['user-agent'] || '').slice(0, 250),
     (req.headers['cf-ipcountry'] || '').slice(0, 2) || null, deviceHash(req), String(REFRESH_TTL_DAYS)]);
  res.cookie(COOKIE, raw, cookieOpts());
  return signAccess(user);
}

// Rotate: revoke the presented refresh token and issue a fresh one.
async function rotateSession(req, res) {
  const raw = req.cookies && req.cookies[COOKIE];
  if (!raw) return null;
  const s = await one(`SELECT * FROM sessions WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at > NOW()`, [sha256(raw)]);
  if (!s) { res.clearCookie(COOKIE, { path: '/api/auth' }); return null; }
  const user = await one('SELECT * FROM users WHERE id=$1', [s.user_id]);
  if (!user) return null;
  await query('UPDATE sessions SET revoked_at=NOW() WHERE id=$1', [s.id]);
  const access = await issueSession(req, res, user);
  return { user, access };
}

async function revokeCurrent(req, res) {
  const raw = req.cookies && req.cookies[COOKIE];
  if (raw) await query('UPDATE sessions SET revoked_at=NOW() WHERE token_hash=$1', [sha256(raw)]);
  res.clearCookie(COOKIE, { path: '/api/auth' });
}

async function revokeAll(userId) {
  await query('UPDATE sessions SET revoked_at=NOW() WHERE user_id=$1 AND revoked_at IS NULL', [userId]);
  await query('UPDATE users SET token_version = token_version + 1 WHERE id=$1', [userId]);
}

module.exports = { signAccess, issueSession, rotateSession, revokeCurrent, revokeAll, COOKIE };
