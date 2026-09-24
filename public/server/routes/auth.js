const express = require('express');
const bcrypt = require('bcryptjs');
const { one, many, query } = require('../db');
const cfg = require('../config');
const { requireAuth, requireAuthLenient } = require('../middleware/auth');
const limits = require('../middleware/limits');
const { HttpError, asyncHandler, sha256, randomToken, hmacHex, timingSafeEqualStr, parseDob, ageFromDob,
        normalizeGender, EMAIL_RE, isDisposableEmail, normalizePhone, clientIp, deviceHash } = require('../lib/util');
const { serializeSelf } = require('../lib/serialize');
const { loadSelfExtras } = require('../services/profile');
const tokens = require('../services/tokens');
const { sendMail } = require('../lib/mailer');
const { sendSms } = require('../lib/sms');
const { verifyGoogleToken } = require('../lib/googleAuth');
const { recordSignal } = require('../lib/risk');
const { notify } = require('../lib/notify');
const { audit } = require('../lib/audit');

const router = express.Router();
const ORIGIN = () => process.env.APP_ORIGIN || `http://localhost:${process.env.PORT || 4000}`;

async function selfPayload(user) { return serializeSelf(user, await loadSelfExtras(user.id)); }

function defaultPrefGenders(interestedIn) {
  const s = String(interestedIn || 'everyone').toLowerCase();
  if (s === 'women') return ['woman'];
  if (s === 'men') return ['man'];
  return [];
}

async function isBanned(email, googleSub) {
  const hashes = [['email', sha256(String(email).toLowerCase())]];
  if (googleSub) hashes.push(['google', sha256(googleSub)]);
  for (const [k, h] of hashes) if (await one('SELECT 1 FROM banned_identities WHERE kind=$1 AND hash=$2', [k, h])) return true;
  return false;
}

async function sendVerifyEmail(user) {
  const raw = randomToken(32);
  await query(`INSERT INTO email_tokens (user_id, token_hash, purpose, expires_at) VALUES ($1,$2,'verify', NOW() + INTERVAL '24 hours')`, [user.id, sha256(raw)]);
  const link = `${ORIGIN()}/?verify_email=${raw}`;
  await sendMail({ to: user.email, subject: `Verify your ${cfg.BRAND_NAME} email`,
    text: `Hi ${user.name},\n\nConfirm your email address:\n${link}\n\nThis link expires in 24 hours. If you did not sign up, ignore this message.` });
}

async function recordLogin(req, user, kind) {
  const dev = deviceHash(req);
  const prior = await many(`SELECT DISTINCT device_hash FROM login_events WHERE user_id=$1 AND kind IN ('login','signup')`, [user.id]);
  const newDevice = prior.length > 0 && !prior.some((p) => p.device_hash === dev);
  await query(`INSERT INTO login_events (user_id, kind, ip, user_agent, geo_country, device_hash, new_device) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [user.id, kind, clientIp(req), (req.headers['user-agent'] || '').slice(0, 250), (req.headers['cf-ipcountry'] || '').slice(0, 2) || null, dev, newDevice]);
  if (newDevice && kind === 'login') {
    sendMail({ to: user.email, subject: `New sign-in to your ${cfg.BRAND_NAME} account`,
      text: `We noticed a sign-in from a new device or location.\n\nIf this was you, no action is needed. If not, open Settings → Security → "Log out everywhere" and change your password.` }).catch(() => {});
    notify(user.id, { type: 'account', title: 'New sign-in detected', body: 'If this was not you, log out everywhere in Settings.' }).catch(() => {});
  }
  return newDevice;
}

// ---------------- Signup ----------------
router.post('/signup', limits.signup, asyncHandler(async (req, res) => {
  const { email, password, name, dob, gender, interestedIn, acceptTerms, country } = req.body || {};
  if (!email || !EMAIL_RE.test(String(email).trim())) throw new HttpError(400, 'A valid email is required');
  if (!password || String(password).length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  if (String(password).length > 128) throw new HttpError(400, 'Password is too long');
  if (!name || !String(name).trim()) throw new HttpError(400, 'Name is required');
  if (acceptTerms !== true) throw new HttpError(400, 'You must accept the Terms and Privacy Policy.', { code: 'terms_required' });
  const dobStr = parseDob(dob);
  if (!dobStr) throw new HttpError(400, 'Date of birth is required (YYYY-MM-DD).');
  const age = ageFromDob(dobStr);
  if (age < cfg.MIN_AGE) throw new HttpError(400, `You must be at least ${cfg.MIN_AGE} years old. ${cfg.BRAND_NAME} is for adults only.`, { code: 'underage' });
  if (age > cfg.MAX_AGE) throw new HttpError(400, 'Please enter a valid date of birth.');

  const normalizedEmail = String(email).trim().toLowerCase();
  if (await isBanned(normalizedEmail)) throw new HttpError(403, 'This email cannot be used to create an account.', { code: 'banned_identity' });
  if (await one('SELECT id FROM users WHERE email=$1', [normalizedEmail])) throw new HttpError(409, 'An account with that email already exists');

  const hash = await bcrypt.hash(String(password), 10);
  const user = await one(
    `INSERT INTO users (email, password_hash, auth_provider, name, dob, age, gender, interested_in, pref_genders, country, bio, job, location, interests, photos,
                        verified, is_demo, tos_accepted_at, privacy_version, signup_ip)
     VALUES ($1,$2,'local',$3,$4,$5,$6,$7,$8,$9,'','','','[]','[]',false,false,NOW(),$10,$11) RETURNING *`,
    [normalizedEmail, hash, String(name).trim().slice(0, 60), dobStr, age, normalizeGender(gender), interestedIn || 'everyone',
     defaultPrefGenders(interestedIn), country ? String(country).slice(0, 60) : '', cfg.LEGAL_VERSION, clientIp(req)]);

  // Abuse signals.
  if (isDisposableEmail(normalizedEmail)) await recordSignal(user.id, 'disposable_email', { domain: normalizedEmail.split('@')[1] });
  const burst = await one(`SELECT COUNT(*) c FROM users WHERE signup_ip=$1 AND created_at > NOW() - INTERVAL '24 hours'`, [clientIp(req)]);
  if (Number(burst.c) >= 4) await recordSignal(user.id, 'signup_velocity', { ip_count: Number(burst.c) });
  await recordLogin(req, user, 'signup');
  sendVerifyEmail(user).catch(() => {});
  await query('UPDATE users SET is_online=true WHERE id=$1', [user.id]);
  const access = await tokens.issueSession(req, res, user);
  res.status(201).json({ token: access, user: await selfPayload(user) });
}));

// ---------------- Login ----------------
router.post('/login', limits.auth, asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) throw new HttpError(400, 'Email and password are required');
  const user = await one('SELECT * FROM users WHERE email=$1', [String(email).trim().toLowerCase()]);
  if (user && user.locked_until && new Date(user.locked_until) > new Date())
    throw new HttpError(429, 'Too many failed attempts. Try again in a few minutes.', { code: 'locked' });
  const ok = user && user.password_hash && await bcrypt.compare(String(password), user.password_hash);
  if (!ok) {
    if (user) {
      const n = user.failed_logins + 1;
      const lockUntil = n >= cfg.MAX_FAILED_LOGINS ? new Date(Date.now() + cfg.LOCKOUT_MINUTES * 60000) : null;
      await query('UPDATE users SET failed_logins=$2, locked_until=$3 WHERE id=$1', [user.id, n, lockUntil]);
      await query(`INSERT INTO login_events (user_id, kind, ip, device_hash) VALUES ($1,'failed_login',$2,$3)`, [user.id, clientIp(req), deviceHash(req)]);
    }
    throw new HttpError(401, 'Invalid email or password');
  }
  if (user.status === 'banned' || user.status === 'deleted') throw new HttpError(403, 'This account has been banned.', { code: 'account_banned' });
  await query('UPDATE users SET failed_logins=0, locked_until=NULL, is_online=true, last_active_at=NOW() WHERE id=$1', [user.id]);
  await recordLogin(req, user, 'login');
  const access = await tokens.issueSession(req, res, user);
  res.json({ token: access, user: await selfPayload(await one('SELECT * FROM users WHERE id=$1', [user.id])) });
}));

// ---------------- Google ----------------
router.post('/google', limits.auth, asyncHandler(async (req, res) => {
  const { credential, acceptTerms } = req.body || {};
  if (!credential) throw new HttpError(400, 'credential is required');
  let g;
  try { g = await verifyGoogleToken(credential); }
  catch (e) { throw new HttpError(e.status || 401, e.status === 501 ? e.message : 'Could not verify Google sign-in'); }
  if (!g.emailVerified) throw new HttpError(403, 'Your Google email address is not verified.');
  if (await isBanned(g.email, g.sub)) throw new HttpError(403, 'This account cannot be used.', { code: 'banned_identity' });

  let user = await one('SELECT * FROM users WHERE google_id=$1', [g.sub]);
  if (!user) {
    const byEmail = await one('SELECT * FROM users WHERE email=$1', [g.email]);
    if (byEmail) {
      user = await one(`UPDATE users SET google_id=$2, email_verified_at=COALESCE(email_verified_at, NOW()) WHERE id=$1 RETURNING *`, [byEmail.id, g.sub]);
    } else {
      if (acceptTerms !== true) throw new HttpError(400, 'You must accept the Terms and Privacy Policy.', { code: 'terms_required' });
      user = await one(
        `INSERT INTO users (email, auth_provider, google_id, name, email_verified_at, bio, job, location, country, interests, photos, verified, is_demo, tos_accepted_at, privacy_version, signup_ip)
         VALUES ($1,'google',$2,$3,NOW(),'','','','','[]','[]',false,false,NOW(),$4,$5) RETURNING *`,
        [g.email, g.sub, g.name.slice(0, 60), cfg.LEGAL_VERSION, clientIp(req)]);
      await recordLogin(req, user, 'signup');
    }
  }
  if (user.status === 'banned' || user.status === 'deleted') throw new HttpError(403, 'This account has been banned.', { code: 'account_banned' });
  await query('UPDATE users SET is_online=true, last_active_at=NOW() WHERE id=$1', [user.id]);
  await recordLogin(req, user, 'login');
  const access = await tokens.issueSession(req, res, user);
  res.json({ token: access, user: await selfPayload(user), isNew: !user.dob });
}));

// ---------------- Session ----------------
router.post('/refresh', asyncHandler(async (req, res) => {
  if (req.headers['x-matchify-csrf'] !== '1') throw new HttpError(403, 'Missing CSRF header', { code: 'csrf' });
  const r = await tokens.rotateSession(req, res);
  if (!r) throw new HttpError(401, 'No active session', { code: 'no_session' });
  if (r.user.status === 'banned' || r.user.status === 'deleted') throw new HttpError(403, 'This account has been banned.', { code: 'account_banned' });
  await query('UPDATE users SET is_online=true, last_active_at=NOW() WHERE id=$1', [r.user.id]);
  res.json({ token: r.access, user: await selfPayload(r.user) });
}));

router.post('/logout', asyncHandler(async (req, res) => {
  await tokens.revokeCurrent(req, res);
  const h = req.headers.authorization;
  if (h) { try { const { authenticateToken } = require('../middleware/auth'); const u = await authenticateToken(h.slice(7)); await query('UPDATE users SET is_online=false WHERE id=$1', [u.id]); } catch (e) { /* already logged out */ } }
  res.json({ ok: true });
}));

router.post('/logout-all', requireAuthLenient, asyncHandler(async (req, res) => {
  await tokens.revokeAll(req.userId);
  res.clearCookie(tokens.COOKIE, { path: '/api/auth' });
  require('../lib/realtime').disconnectUser(req.userId, 'logout_all');
  res.json({ ok: true });
}));

router.get('/sessions', requireAuthLenient, asyncHandler(async (req, res) => {
  const rows = await many(`SELECT id, ip, user_agent, geo_country, created_at, last_used_at FROM sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at > NOW() ORDER BY created_at DESC LIMIT 20`, [req.userId]);
  res.json({ sessions: rows });
}));

router.get('/me', requireAuthLenient, asyncHandler(async (req, res) => {
  res.json({ user: await selfPayload(req.user) });
}));

router.post('/password', requireAuth, limits.auth, asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 8) throw new HttpError(400, 'New password must be at least 8 characters');
  if (req.user.password_hash && !(await bcrypt.compare(String(currentPassword || ''), req.user.password_hash))) throw new HttpError(401, 'Current password is incorrect');
  await query('UPDATE users SET password_hash=$2 WHERE id=$1', [req.userId, await bcrypt.hash(String(newPassword), 10)]);
  await tokens.revokeAll(req.userId);
  const fresh = await one('SELECT * FROM users WHERE id=$1', [req.userId]);
  const access = await tokens.issueSession(req, res, fresh);
  res.json({ ok: true, token: access });
}));

// ---------------- Email verification / reset ----------------
router.post('/email/send', requireAuth, limits.otp, asyncHandler(async (req, res) => {
  if (req.user.email_verified_at) return res.json({ ok: true, alreadyVerified: true });
  await sendVerifyEmail(req.user);
  res.json({ ok: true });
}));

router.post('/email/verify', limits.auth, asyncHandler(async (req, res) => {
  const { token } = req.body || {};
  if (!token) throw new HttpError(400, 'token is required');
  const t = await one(`SELECT * FROM email_tokens WHERE token_hash=$1 AND purpose='verify' AND used_at IS NULL AND expires_at > NOW()`, [sha256(token)]);
  if (!t) throw new HttpError(400, 'This link is invalid or has expired.');
  await query('UPDATE email_tokens SET used_at=NOW() WHERE id=$1', [t.id]);
  await query('UPDATE users SET email_verified_at=NOW() WHERE id=$1', [t.user_id]);
  res.json({ ok: true });
}));

router.post('/forgot', limits.auth, asyncHandler(async (req, res) => {
  const user = await one('SELECT * FROM users WHERE email=$1', [String(req.body?.email || '').trim().toLowerCase()]);
  if (user && user.password_hash) {
    const raw = randomToken(32);
    await query(`INSERT INTO email_tokens (user_id, token_hash, purpose, expires_at) VALUES ($1,$2,'reset', NOW() + INTERVAL '1 hour')`, [user.id, sha256(raw)]);
    await sendMail({ to: user.email, subject: `Reset your ${cfg.BRAND_NAME} password`, text: `Reset your password (valid for 1 hour):\n${ORIGIN()}/?reset_token=${raw}\n\nIf you did not request this, ignore this email.` });
  }
  res.json({ ok: true });   // never reveal whether the email exists
}));

router.post('/reset', limits.auth, asyncHandler(async (req, res) => {
  const { token, password } = req.body || {};
  if (!password || String(password).length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  const t = await one(`SELECT * FROM email_tokens WHERE token_hash=$1 AND purpose='reset' AND used_at IS NULL AND expires_at > NOW()`, [sha256(token || '')]);
  if (!t) throw new HttpError(400, 'This reset link is invalid or has expired.');
  await query('UPDATE email_tokens SET used_at=NOW() WHERE id=$1', [t.id]);
  await query('UPDATE users SET password_hash=$2, failed_logins=0, locked_until=NULL, email_verified_at=COALESCE(email_verified_at,NOW()) WHERE id=$1', [t.user_id, await bcrypt.hash(String(password), 10)]);
  await tokens.revokeAll(t.user_id);
  res.json({ ok: true });
}));

// ---------------- Phone OTP ----------------
const otpHash = (userId, phone, code) => hmacHex(process.env.JWT_SECRET, `${userId}|${phone}|${code}`);

router.post('/phone/send', requireAuth, limits.otp, asyncHandler(async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  if (!phone) throw new HttpError(400, 'Enter a valid phone number with country code (e.g. +919876543210).');
  const taken = await one('SELECT id FROM users WHERE phone=$1 AND phone_verified_at IS NOT NULL AND id<>$2', [phone, req.userId]);
  if (taken) throw new HttpError(409, 'That phone number is already linked to another account.');
  const recent = await one(`SELECT COUNT(*) c FROM otp_codes WHERE phone=$1 AND created_at > NOW() - INTERVAL '1 hour'`, [phone]);
  if (Number(recent.c) >= 3) throw new HttpError(429, 'Too many codes for this number. Try again in an hour.', { code: 'rate_limited' });
  const code = String(require('crypto').randomInt(0, 1000000)).padStart(6, '0');
  await query(`INSERT INTO otp_codes (user_id, phone, code_hash, expires_at) VALUES ($1,$2,$3, NOW() + INTERVAL '5 minutes')`, [req.userId, phone, otpHash(req.userId, phone, code)]);
  await sendSms(phone, `${code} is your ${cfg.BRAND_NAME} verification code. It expires in 5 minutes. Do not share it.`);
  res.json({ ok: true });
}));

router.post('/phone/verify', requireAuth, limits.otp, asyncHandler(async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  const code = String(req.body?.code || '').trim();
  if (!phone || !/^\d{6}$/.test(code)) throw new HttpError(400, 'Phone and 6-digit code are required.');
  const otp = await one(`SELECT * FROM otp_codes WHERE user_id=$1 AND phone=$2 AND used_at IS NULL AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1`, [req.userId, phone]);
  if (!otp) throw new HttpError(400, 'Code expired. Request a new one.');
  if (otp.attempts >= 5) throw new HttpError(429, 'Too many wrong attempts. Request a new code.', { code: 'rate_limited' });
  if (!timingSafeEqualStr(otp.code_hash, otpHash(req.userId, phone, code))) {
    await query('UPDATE otp_codes SET attempts=attempts+1 WHERE id=$1', [otp.id]);
    throw new HttpError(400, 'Incorrect code.');
  }
  await query('UPDATE otp_codes SET used_at=NOW() WHERE id=$1', [otp.id]);
  try {
    await query('UPDATE users SET phone=$2, phone_verified_at=NOW() WHERE id=$1', [req.userId, phone]);
  } catch (e) { throw new HttpError(409, 'That phone number is already linked to another account.'); }
  res.json({ ok: true, user: await selfPayload(await one('SELECT * FROM users WHERE id=$1', [req.userId])) });
}));

// ---------------- Demo session (non-production + DEMO_MODE only) ----------------
const DEMO_EMAIL = 'you@matchify.invalid';
router.post('/demo', asyncHandler(async (req, res) => {
  if (!cfg.demoVisible()) throw new HttpError(403, 'Demo mode is disabled. Please sign up or log in.');
  let user = await one('SELECT * FROM users WHERE email=$1', [DEMO_EMAIL]);
  if (!user) {
    user = await one(
      `INSERT INTO users (email, auth_provider, name, dob, age, gender, interested_in, bio, interests, photos, verified, is_demo, verification_status, over_18, tos_accepted_at)
       VALUES ($1,'demo','You','1997-01-01',29,'other','everyone','Just exploring (guest demo account).','[]','[]',false,false,'verified',true,NOW()) RETURNING *`, [DEMO_EMAIL]);
  }
  await query('UPDATE users SET is_online=true WHERE id=$1', [user.id]);
  const access = await tokens.issueSession(req, res, user);
  res.json({ token: access, user: await selfPayload(user) });
}));

router.get('/config', (req, res) => {
  res.json({
    brand: cfg.BRAND_NAME,
    demoMode: cfg.demoVisible(),
    requireAgeVerification: cfg.REQUIRE_AGE_VERIFICATION(),
    verificationProviderConfigured: require('../services/verification').providerConfigured(),
    verificationProvider: cfg.VERIFICATION_PROVIDER() || (cfg.isProd() ? null : 'mock'),
    googleClientId: process.env.GOOGLE_CLIENT_ID || null,
    razorpayKeyId: process.env.RAZORPAY_KEY_ID || null,
    paymentsDevMode: !cfg.isProd() && process.env.PAYMENTS_DEV_MODE === 'true',
    vapidPublicKey: process.env.VAPID_PUBLIC_KEY || null,
    maxPhotos: cfg.MAX_PROFILE_PHOTOS, minPhotos: cfg.MIN_PROFILE_PHOTOS,
    legalVersion: cfg.LEGAL_VERSION,
    promptKeys: cfg.PROMPT_KEYS, intents: cfg.INTENTS,
  });
});

module.exports = { router, selfPayload, sendVerifyEmail };
