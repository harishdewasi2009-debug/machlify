const rateLimit = require('express-rate-limit');
const { RATE_LIMIT_DISABLED } = require('../config');

const skip = () => RATE_LIMIT_DISABLED();
const mk = (windowMs, max, keyFn, message) => rateLimit({
  windowMs, max, skip, standardHeaders: true, legacyHeaders: false,
  keyGenerator: keyFn || undefined,
  handler: (req, res) => res.status(429).json({ error: message || 'Too many requests — slow down and try again shortly.', code: 'rate_limited' }),
});
const ipKey = (req) => req.ip;
const userKey = (req) => (req.userId ? 'u' + req.userId : req.ip);

module.exports = {
  general: mk(60 * 1000, 240, ipKey),
  auth: mk(60 * 1000, 20, ipKey, 'Too many attempts. Please wait a minute.'),
  signup: mk(60 * 60 * 1000, 20, ipKey, 'Too many signups from this network. Try again later.'),
  otp: mk(10 * 60 * 1000, 5, (req) => 'otp:' + (req.userId || req.ip), 'Too many verification codes requested. Try again in a few minutes.'),
  ai: mk(60 * 1000, 20, userKey),
  upload: mk(60 * 60 * 1000, 40, userKey, 'Too many uploads. Try again later.'),
  reports: mk(60 * 60 * 1000, 30, userKey),
  payments: mk(60 * 1000, 20, userKey),
};
