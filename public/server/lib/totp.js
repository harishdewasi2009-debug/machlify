// RFC 6238 TOTP (SHA-1, 6 digits, 30 s) — compatible with Google Authenticator / Authy.
const crypto = require('crypto');
const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function b32encode(buf) {
  let bits = '', out = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i < bits.length; i += 5) out += A[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}
function b32decode(s) {
  let bits = '';
  for (const ch of s.replace(/=+$/, '').toUpperCase()) { const v = A.indexOf(ch); if (v < 0) continue; bits += v.toString(2).padStart(5, '0'); }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
const generateSecret = () => b32encode(crypto.randomBytes(20));
function code(secret, at = Date.now()) {
  const counter = Math.floor(at / 30000);
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', b32decode(secret)).update(buf).digest();
  const o = h[h.length - 1] & 0xf;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1000000).padStart(6, '0');
}
function verify(secret, token, window = 1, at = Date.now()) {
  const t = String(token || '').trim();
  if (!/^\d{6}$/.test(t)) return false;
  for (let w = -window; w <= window; w++) if (crypto.timingSafeEqual(Buffer.from(code(secret, at + w * 30000)), Buffer.from(t))) return true;
  return false;
}
const otpauthUrl = (label, secret, issuer) => `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}`;
module.exports = { generateSecret, code, verify, otpauthUrl };
