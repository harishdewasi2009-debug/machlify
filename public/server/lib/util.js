const crypto = require('crypto');

class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('hex');
const timingSafeEqualStr = (a, b) => {
  const A = Buffer.from(String(a)); const B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
};
const hmacHex = (secret, payload, algo = 'sha256') => crypto.createHmac(algo, secret).update(payload).digest('hex');

function parseJson(text, fallback) {
  if (text == null) return fallback;
  if (typeof text !== 'string') return text;
  try { return JSON.parse(text); } catch (e) { return fallback; }
}

// ---- dates / age ----
function ageFromDob(dob, now = new Date()) {
  if (!dob) return null;
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  let age = now.getUTCFullYear() - d.getUTCFullYear();
  const m = now.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < d.getUTCDate())) age--;
  return age;
}
const DOB_RE = /^\d{4}-\d{2}-\d{2}$/;
function parseDob(v) {
  if (!v || !DOB_RE.test(String(v))) return null;
  const d = new Date(v + 'T00:00:00Z');
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) return null;
  return v;
}
function userAge(u) { return u.dob ? ageFromDob(u.dob) : (u.age || null); }

// ---- normalisation ----
function normalizeGender(g) {
  const s = String(g || '').trim().toLowerCase();
  if (['female', 'woman', 'women', 'f'].includes(s)) return 'woman';
  if (['male', 'man', 'men', 'm'].includes(s)) return 'man';
  if (['nonbinary', 'non-binary', 'non binary', 'enby'].includes(s)) return 'nonbinary';
  if (s) return 'other';
  return null;
}
function normalizeInterests(list, max = 15) {
  if (!Array.isArray(list)) return [];
  const seen = new Set(); const out = [];
  for (const raw of list) {
    const t = String(raw || '').trim().replace(/\s+/g, ' ').slice(0, 30);
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase()); out.push(t);
    if (out.length >= max) break;
  }
  return out;
}
const interestTags = (list) => normalizeInterests(list).map((s) => s.toLowerCase());

// Coarsen coordinates (~1.1 km grid) so exact positions are never stored.
const coarse = (n) => (n == null ? null : Math.round(Number(n) * 100) / 100);
function validLatLng(lat, lng) {
  lat = Number(lat); lng = Number(lng);
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}
function distanceBand(km) {
  if (km == null) return null;
  const bands = [2, 5, 10, 25, 50, 100, 250, 500];
  for (const b of bands) if (km <= b) return b;
  return 1000;
}
function distanceLabel(km) {
  const b = distanceBand(km);
  if (b == null) return null;
  return b <= 2 ? 'less than 2 km away' : b >= 1000 ? 'more than 500 km away' : `within ${b} km`;
}

function clientIp(req) {
  return (req.ip || req.socket?.remoteAddress || '').replace('::ffff:', '');
}
const deviceHash = (req) => sha256((req.headers['user-agent'] || '') + '|' + (req.headers['accept-language'] || '')).slice(0, 24);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DISPOSABLE = new Set(['mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com', 'yopmail.com', 'trashmail.com', 'sharklasers.com', 'getnada.com', 'throwawaymail.com', 'dispostable.com', 'maildrop.cc', 'fakeinbox.com']);
const isDisposableEmail = (email) => DISPOSABLE.has(String(email).split('@')[1]?.toLowerCase());
function normalizePhone(p) {
  let s = String(p || '').replace(/[\s\-()]/g, '');
  if (/^[6-9]\d{9}$/.test(s)) s = '+91' + s;
  if (!/^\+[1-9]\d{7,14}$/.test(s)) return null;
  return s;
}

module.exports = {
  HttpError, asyncHandler, sha256, randomToken, timingSafeEqualStr, hmacHex, parseJson,
  ageFromDob, parseDob, userAge, normalizeGender, normalizeInterests, interestTags, coarse, validLatLng,
  distanceBand, distanceLabel, clientIp, deviceHash, EMAIL_RE, isDisposableEmail, normalizePhone,
};
