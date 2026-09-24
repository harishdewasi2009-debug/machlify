const express = require('express');
const jwt = require('jsonwebtoken');
const { one, many, query } = require('../db');
const cfg = require('../config');
const { requireAuth, requireRole } = require('../middleware/auth');
const { HttpError, asyncHandler, parseJson } = require('../lib/util');
const totp = require('../lib/totp');
const { audit } = require('../lib/audit');
const { explain } = require('../lib/risk');
const { applyAction } = require('../services/moderationActions');
const { refreshProfile } = require('../services/profile');
const storage = require('../lib/storage');
const { notify } = require('../lib/notify');
const payments = require('../services/payments');
const verification = require('../services/verification');
const { refreshUserPlan } = require('../lib/entitlements');

const router = express.Router();
const ip = (req) => (req.ip || '').replace('::ffff:', '');
const adminOnly = requireRole('admin');

router.use(requireAuth, requireRole('moderator', 'admin'));

// ---- staff 2FA (TOTP). Required for every other admin route when REQUIRE_STAFF_2FA is on (default in production). ----
const signAdminToken = (u) => jwt.sign({ userId: u.id, staff2fa: true, tv: u.token_version }, process.env.REFRESH_SECRET || process.env.JWT_SECRET, { expiresIn: '4h' });

router.get('/me', asyncHandler(async (req, res) => {
  res.json({ id: req.user.id, name: req.user.name, role: req.user.role, twoFactorEnabled: !!req.user.staff_totp_enabled, twoFactorRequired: cfg.REQUIRE_STAFF_2FA() });
}));
router.post('/2fa/setup', asyncHandler(async (req, res) => {
  if (req.user.staff_totp_enabled) throw new HttpError(400, '2FA is already enabled.');
  const secret = totp.generateSecret();
  await query('UPDATE users SET staff_totp_secret=$2 WHERE id=$1', [req.userId, secret]);
  res.json({ secret, otpauthUrl: totp.otpauthUrl(req.user.email, secret, cfg.BRAND_NAME + ' Admin') });
}));
router.post('/2fa/verify', asyncHandler(async (req, res) => {
  const u = req.user;
  if (!u.staff_totp_secret) throw new HttpError(400, 'Set up 2FA first.');
  if (!totp.verify(u.staff_totp_secret, req.body?.code)) { await audit(u, 'admin.2fa_failed', 'user', u.id, {}, ip(req)); throw new HttpError(401, 'Invalid code'); }
  if (!u.staff_totp_enabled) await query('UPDATE users SET staff_totp_enabled=true WHERE id=$1', [u.id]);
  await audit(u, 'admin.login', 'user', u.id, {}, ip(req));
  res.json({ adminToken: signAdminToken(u) });
}));

router.use((req, res, next) => {
  if (!cfg.REQUIRE_STAFF_2FA()) return next();
  try {
    const p = jwt.verify(req.headers['x-admin-token'] || '', process.env.REFRESH_SECRET || process.env.JWT_SECRET);
    if (p.userId !== req.userId || !p.staff2fa || p.tv !== req.user.token_version) throw new Error('mismatch');
    next();
  } catch (e) { next(new HttpError(401, 'Two-factor authentication required.', { code: 'staff_2fa_required' })); }
});

// ---- overview ----
router.get('/stats', asyncHandler(async (req, res) => {
  const q = (sql, p) => one(sql, p).then((r) => Number(Object.values(r)[0]));
  const real = 'is_demo = false';
  const [total, active, new7, verified, pendingV, reportsOpen, reportsP1, photosQ, riskHigh, appeals, restricted, rev30, subs, dau] = await Promise.all([
    q(`SELECT COUNT(*) FROM users WHERE ${real}`), q(`SELECT COUNT(*) FROM users WHERE ${real} AND status='active'`),
    q(`SELECT COUNT(*) FROM users WHERE ${real} AND created_at > NOW() - INTERVAL '7 days'`),
    q(`SELECT COUNT(*) FROM users WHERE ${real} AND verification_status='verified'`), q(`SELECT COUNT(*) FROM users WHERE ${real} AND verification_status='pending'`),
    q(`SELECT COUNT(*) FROM reports WHERE status IN ('open','in_review')`), q(`SELECT COUNT(*) FROM reports WHERE status IN ('open','in_review') AND priority=1`),
    q(`SELECT COUNT(*) FROM photos p JOIN users u ON u.id=p.user_id WHERE p.status='needs_review' AND u.is_demo=false`),
    q(`SELECT COUNT(*) FROM users WHERE ${real} AND risk_level='high'`), q(`SELECT COUNT(*) FROM appeals WHERE status='open'`),
    q(`SELECT COUNT(*) FROM users WHERE ${real} AND status='restricted'`),
    q(`SELECT COALESCE(SUM(p.amount),0) FROM payments p JOIN users u ON u.id=p.user_id WHERE p.status='paid' AND u.is_demo=false AND p.created_at > NOW() - INTERVAL '30 days'`),
    q(`SELECT COUNT(*) FROM subscriptions s JOIN users u ON u.id=s.user_id WHERE s.status='active' AND u.is_demo=false`),
    q(`SELECT COUNT(*) FROM users WHERE ${real} AND last_active_at > NOW() - INTERVAL '24 hours'`),
  ]);
  res.json({ note: 'Demo profiles are excluded from all metrics.', users: { total, active, new7d: new7, verified, pendingVerification: pendingV, restricted, active24h: dau },
    safety: { openReports: reportsOpen, priorityOneReports: reportsP1, photosAwaitingReview: photosQ, highRisk: riskHigh, openAppeals: appeals },
    revenue: { last30dInr: rev30 / 100, activeSubscriptions: subs } });
}));

// ---- users ----
router.get('/users', asyncHandler(async (req, res) => {
  const { q, status, risk, limit = 30, offset = 0 } = req.query;
  const params = []; const conds = [req.query.demo === 'true' ? 'TRUE' : 'u.is_demo = false'];
  if (q) { params.push('%' + String(q).toLowerCase() + '%'); conds.push(`(LOWER(u.email) LIKE $${params.length} OR LOWER(u.name) LIKE $${params.length} OR CAST(u.id AS TEXT) = ${'$' + (params.push(String(q)))})`); }
  if (status) { params.push(status); conds.push(`u.status = $${params.length}`); }
  if (risk) { params.push(risk); conds.push(`u.risk_level = $${params.length}`); }
  params.push(Math.min(parseInt(limit, 10) || 30, 100), parseInt(offset, 10) || 0);
  const rows = await many(`SELECT u.id, u.email, u.name, u.role, u.status, u.risk_level, u.risk_score, u.verification_status, u.photo_verified, u.plan, u.created_at, u.last_active_at, u.is_demo
                             FROM users u WHERE ${conds.join(' AND ')} ORDER BY u.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  res.json({ users: rows });
}));

router.get('/users/:id', asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const u = await one('SELECT * FROM users WHERE id=$1', [id]);
  if (!u) throw new HttpError(404, 'User not found');
  const { password_hash, staff_totp_secret, ...safe } = u;
  const [photos, prompts, verifs, actions, reportsAgainst, reportsBy, logins, pays, signals] = await Promise.all([
    many('SELECT id, url, status, moderation, created_at FROM photos WHERE user_id=$1 ORDER BY position', [id]),
    many('SELECT prompt_key, answer FROM profile_prompts WHERE user_id=$1', [id]),
    many('SELECT kind, provider, status, over_18, reason, created_at, completed_at FROM verifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 10', [id]),
    many('SELECT id, action, reason, actor_id, expires_at, created_at, reversed_at FROM moderation_actions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50', [id]),
    many('SELECT id, reason, status, context, priority, created_at FROM reports WHERE reported_id=$1 ORDER BY created_at DESC LIMIT 30', [id]),
    many('SELECT id, reason, status, created_at FROM reports WHERE reporter_id=$1 ORDER BY created_at DESC LIMIT 30', [id]),
    many(`SELECT kind, ip, geo_country, new_device, created_at FROM login_events WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20`, [id]),
    req.user.role === 'admin' ? many('SELECT id, product_key, amount, status, created_at FROM payments WHERE user_id=$1 ORDER BY created_at DESC LIMIT 30', [id]) : [],
    explain(id),
  ]);
  await audit(req.user, 'admin.view_user', 'user', id, {}, ip(req));
  res.json({ user: { ...safe, interests: parseJson(u.interests, []), photos: undefined }, photos, prompts, verifications: verifs, moderationActions: actions, reportsAgainst, reportsBy, logins, payments: pays, riskSignals: signals });
}));

router.post('/users/:id/action', asyncHandler(async (req, res) => {
  const row = await applyAction({ actor: req.user, userId: parseInt(req.params.id, 10), action: req.body?.action, reason: req.body?.reason, days: req.body?.days, reportId: req.body?.reportId, ip: ip(req) });
  res.json({ ok: true, action: row });
}));

router.post('/users/:id/role', adminOnly, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (id === req.userId) throw new HttpError(400, 'You cannot change your own role.');
  if (!['user', 'moderator', 'admin'].includes(req.body?.role)) throw new HttpError(400, 'role must be user, moderator or admin');
  await query('UPDATE users SET role=$2, staff_totp_enabled=CASE WHEN $2=\'user\' THEN false ELSE staff_totp_enabled END WHERE id=$1', [id, req.body.role]);
  await audit(req.user, 'admin.role_change', 'user', id, { role: req.body.role }, ip(req));
  res.json({ ok: true });
}));

router.post('/users/:id/verification', asyncHandler(async (req, res) => {
  // Staff can revoke/reset verification but can never mark someone verified (only the provider can).
  const id = parseInt(req.params.id, 10);
  await applyAction({ actor: req.user, userId: id, action: 'force_reverify', reason: req.body?.reason || 'Manual verification reset', ip: ip(req) });
  res.json({ ok: true });
}));

// ---- reports queue ----
router.get('/reports', asyncHandler(async (req, res) => {
  const { status = 'open', context, limit = 50 } = req.query;
  const params = []; const conds = [];
  if (status === 'open') conds.push(`r.status IN ('open','in_review')`); else if (status !== 'all') { params.push(status); conds.push(`r.status = $${params.length}`); }
  if (context) { params.push(context); conds.push(`r.context = $${params.length}`); }
  params.push(Math.min(parseInt(limit, 10) || 50, 200));
  const rows = await many(
    `SELECT r.id, r.reason, r.status, r.priority, r.context, r.source, r.created_at, r.assigned_to,
            ru.id AS reported_id, ru.name AS reported_name, ru.risk_level, ru.status AS reported_status, rp.name AS reporter_name
       FROM reports r LEFT JOIN users ru ON ru.id=r.reported_id LEFT JOIN users rp ON rp.id=r.reporter_id
      ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''} ORDER BY r.priority ASC, r.created_at ASC LIMIT $${params.length}`, params);
  res.json({ reports: rows });
}));

router.get('/reports/:id', asyncHandler(async (req, res) => {
  const r = await one('SELECT * FROM reports WHERE id=$1', [req.params.id]);
  if (!r) throw new HttpError(404, 'Report not found');
  const [reportedHistory, reporterHistory] = await Promise.all([
    r.reported_id ? many('SELECT id, reason, status, created_at FROM reports WHERE reported_id=$1 AND id<>$2 ORDER BY created_at DESC LIMIT 20', [r.reported_id, r.id]) : [],
    r.reporter_id ? many('SELECT id, reason, status, created_at FROM reports WHERE reporter_id=$1 AND id<>$2 ORDER BY created_at DESC LIMIT 20', [r.reporter_id, r.id]) : [],
  ]);
  await audit(req.user, 'admin.view_report', 'report', r.id, {}, ip(req));
  res.json({ report: r, reportedHistory, reporterHistory });
}));

router.post('/reports/:id/assign', asyncHandler(async (req, res) => {
  const r = await one(`UPDATE reports SET assigned_to=$2, status=CASE WHEN status='open' THEN 'in_review' ELSE status END, updated_at=NOW() WHERE id=$1 RETURNING id`, [req.params.id, req.userId]);
  if (!r) throw new HttpError(404, 'Report not found');
  await audit(req.user, 'report.assign', 'report', r.id, {}, ip(req));
  res.json({ ok: true });
}));

router.post('/reports/:id/resolve', asyncHandler(async (req, res) => {
  const { decision, action, reason, days } = req.body || {};
  const r = await one('SELECT * FROM reports WHERE id=$1', [req.params.id]);
  if (!r) throw new HttpError(404, 'Report not found');
  if (['actioned', 'dismissed'].includes(r.status)) throw new HttpError(409, 'Report already resolved.');
  if (decision === 'dismiss') {
    await query(`UPDATE reports SET status='dismissed', resolution=$2, resolved_by=$3, resolved_at=NOW(), updated_at=NOW() WHERE id=$1`, [r.id, String(reason || 'dismissed').slice(0, 500), req.userId]);
    await audit(req.user, 'report.dismiss', 'report', r.id, { reason }, ip(req));
    return res.json({ ok: true });
  }
  if (decision !== 'action') throw new HttpError(400, 'decision must be "dismiss" or "action"');
  if (!r.reported_id) throw new HttpError(400, 'The reported account no longer exists.');
  const row = await applyAction({ actor: req.user, userId: r.reported_id, action, reason, days, reportId: r.id, ip: ip(req) });
  if (r.reporter_id) notify(r.reporter_id, { type: 'safety', title: 'Thanks for your report', body: 'We reviewed it and took action.' }).catch(() => {});
  res.json({ ok: true, action: row });
}));

// ---- photo review ----
router.get('/photos/queue', asyncHandler(async (req, res) => {
  const rows = await many(`SELECT p.id, p.user_id, p.url, p.thumb_url, p.moderation, p.created_at, u.name FROM photos p JOIN users u ON u.id=p.user_id
                            WHERE p.status='needs_review' AND u.is_demo=false ORDER BY p.created_at LIMIT 100`);
  res.json({ photos: rows });
}));
router.post('/photos/:id/review', asyncHandler(async (req, res) => {
  const p = await one('SELECT * FROM photos WHERE id=$1', [req.params.id]);
  if (!p) throw new HttpError(404, 'Photo not found');
  const { decision } = req.body || {};
  if (decision === 'approve') {
    await query(`UPDATE photos SET status='approved' WHERE id=$1`, [p.id]);
  } else if (decision === 'reject') {
    await query(`UPDATE photos SET status='rejected', url='rejected', thumb_url=NULL, storage_key=NULL WHERE id=$1`, [p.id]);
    if (p.storage_key) { await storage.remove(p.storage_key); await storage.remove(p.storage_key.replace('.jpg', '_t.jpg')); }
    notify(p.user_id, { type: 'safety', title: 'A photo was removed', body: 'One of your photos did not meet our community guidelines.' }).catch(() => {});
  } else throw new HttpError(400, 'decision must be approve or reject');
  await refreshProfile(p.user_id);
  await audit(req.user, `photo.${decision}`, 'photo', p.id, { userId: p.user_id }, ip(req));
  res.json({ ok: true });
}));

// ---- risk / verification queues ----
router.get('/risk', asyncHandler(async (req, res) => {
  const rows = await many(`SELECT id, name, email, status, risk_score, risk_level, created_at FROM users WHERE is_demo=false AND risk_level IN ('medium','high') ORDER BY risk_score DESC LIMIT 100`);
  res.json({ users: rows });
}));
router.get('/verifications', asyncHandler(async (req, res) => {
  const rows = await many(`SELECT u.id, u.name, u.email, u.verification_status, u.verification_rejection_reason, u.verification_submitted_at
                             FROM users u WHERE u.is_demo=false AND u.verification_status IN ('rejected','pending') ORDER BY u.verification_submitted_at DESC NULLS LAST LIMIT 100`);
  res.json({ users: rows, providerConfigured: verification.providerConfigured() });
}));

// ---- appeals ----
router.get('/appeals', asyncHandler(async (req, res) => {
  const rows = await many(`SELECT a.*, u.name, u.email, u.status AS user_status, m.action, m.reason AS action_reason FROM appeals a JOIN users u ON u.id=a.user_id LEFT JOIN moderation_actions m ON m.id=a.action_id
                            WHERE a.status = $1 ORDER BY a.created_at LIMIT 100`, [req.query.status || 'open']);
  res.json({ appeals: rows });
}));
router.post('/appeals/:id/resolve', asyncHandler(async (req, res) => {
  const a = await one('SELECT * FROM appeals WHERE id=$1', [req.params.id]);
  if (!a || a.status !== 'open') throw new HttpError(404, 'Open appeal not found');
  const { decision, note } = req.body || {};
  if (!['upheld', 'overturned'].includes(decision)) throw new HttpError(400, 'decision must be upheld or overturned');
  if (decision === 'overturned') {
    const u = await one('SELECT * FROM users WHERE id=$1', [a.user_id]);
    if (u.status === 'banned' && req.user.role !== 'admin') throw new HttpError(403, 'Only admins can overturn a ban.', { code: 'forbidden' });
    await query(`UPDATE users SET status='active', status_reason=NULL, suspended_until=NULL, discoverable=true WHERE id=$1 AND status IN ('banned','suspended','restricted')`, [a.user_id]);
    if (u.status === 'banned') await query(`DELETE FROM banned_identities WHERE kind='email' AND hash=$1`, [require('../lib/util').sha256(u.email.toLowerCase())]);
    if (a.action_id) await query('UPDATE moderation_actions SET reversed_at=NOW() WHERE id=$1', [a.action_id]);
  }
  await query(`UPDATE appeals SET status=$2, resolved_by=$3, resolution_note=$4, resolved_at=NOW() WHERE id=$1`, [a.id, decision, req.userId, String(note || '').slice(0, 500)]);
  await notify(a.user_id, { type: 'safety', title: decision === 'overturned' ? 'Your appeal was successful' : 'Your appeal was reviewed', body: decision === 'overturned' ? 'Your account has been restored.' : 'We reviewed your appeal and the decision stands.' });
  await audit(req.user, `appeal.${decision}`, 'appeal', a.id, { userId: a.user_id }, ip(req));
  res.json({ ok: true });
}));

// ---- payments (admin only) ----
router.get('/payments', adminOnly, asyncHandler(async (req, res) => {
  const params = []; let cond = '';
  if (req.query.userId) { params.push(parseInt(req.query.userId, 10)); cond = 'WHERE p.user_id=$1'; }
  const rows = await many(`SELECT p.id, p.user_id, u.email, p.product_key, p.amount, p.status, p.razorpay_payment_id, p.created_at FROM payments p LEFT JOIN users u ON u.id=p.user_id ${cond} ORDER BY p.created_at DESC LIMIT 100`, params);
  res.json({ payments: rows });
}));
router.post('/payments/:id/refund', adminOnly, asyncHandler(async (req, res) => res.json(await payments.refundPayment(req.user, parseInt(req.params.id, 10), ip(req)))));

// ---- audit log + config view ----
router.get('/audit', adminOnly, asyncHandler(async (req, res) => {
  const params = []; let cond = '';
  if (req.query.actor) { params.push(parseInt(req.query.actor, 10)); cond = 'WHERE actor_id=$1'; }
  res.json({ entries: await many(`SELECT * FROM audit_log ${cond} ORDER BY id DESC LIMIT 200`, params) });
}));
router.get('/config', adminOnly, asyncHandler(async (req, res) => {
  res.json({
    env: process.env.NODE_ENV, demoVisible: cfg.demoVisible(), requireAgeVerification: cfg.REQUIRE_AGE_VERIFICATION(), verificationProvider: cfg.VERIFICATION_PROVIDER() || null,
    imageModeration: process.env.IMAGE_MODERATION_PROVIDER || 'none', storage: process.env.STORAGE_DRIVER || 'local', smsProvider: process.env.SMS_PROVIDER || null,
    payments: { configured: !!process.env.RAZORPAY_KEY_ID, webhookSecret: !!process.env.RAZORPAY_WEBHOOK_SECRET }, aiConfigured: !!process.env.ANTHROPIC_API_KEY,
    googleConfigured: !!process.env.GOOGLE_CLIENT_ID, pushConfigured: !!process.env.VAPID_PUBLIC_KEY, staff2fa: cfg.REQUIRE_STAFF_2FA(),
    plans: cfg.PLAN_ENTITLEMENTS, products: cfg.PRODUCTS,
  });
}));

module.exports = router;
module.exports.router = router;
