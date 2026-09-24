const express = require('express');
const { one, query } = require('../db');
const { requireAuth, requireAuthLenient } = require('../middleware/auth');
const limits = require('../middleware/limits');
const { HttpError, asyncHandler, sha256 } = require('../lib/util');
const { isProd } = require('../config');
const verification = require('../services/verification');

const router = express.Router();

router.get('/status', requireAuthLenient, asyncHandler(async (req, res) => {
  const u = req.user;
  res.json({
    status: u.verification_status || 'unverified', rejectionReason: u.verification_rejection_reason || null,
    photoVerified: !!u.photo_verified, providerConfigured: verification.providerConfigured(),
  });
}));

router.post('/start', requireAuth, limits.auth, asyncHandler(async (req, res) => {
  const kind = req.body?.kind || 'age_id';
  if (!req.user.dob && kind === 'age_id') throw new HttpError(400, 'Add your date of birth first.', { code: 'dob_required' });
  const r = await verification.start(req.user, kind);
  res.json({ status: r.status, redirectUrl: r.redirectUrl, provider: r.provider, providerConfigured: true });
}));

// Provider → us. Raw body is required for signature verification (mounted with express.raw in app.js).
router.post('/webhook', asyncHandler(async (req, res) => {
  let provider;
  try { provider = verification.getProvider(); } catch (e) { throw new HttpError(501, 'No verification provider configured'); }
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
  const evt = provider.parseWebhook(raw, req.headers);
  if (evt.error) throw new HttpError(evt.status || 400, evt.error);
  if (evt.ignore) return res.json({ ok: true, ignored: true });
  if (evt.eventId) {
    const seen = await one(`INSERT INTO webhook_events (id, provider, event) VALUES ($1,'verification',$2) ON CONFLICT DO NOTHING RETURNING id`, ['v:' + evt.eventId, evt.result]);
    if (!seen) return res.json({ ok: true, replay: true });
  }
  res.json(await verification.applyResult(evt));
}));

// DEV ONLY: finish a mock verification from /verify-mock.html. Absent in production.
router.post('/dev-complete', requireAuth, asyncHandler(async (req, res) => {
  if (isProd() || verification.getProvider().name !== 'mock') throw new HttpError(404, 'Not found');
  const { sessionRef, result, verifiedDob } = req.body || {};
  const v = await one('SELECT * FROM verifications WHERE session_ref=$1 AND user_id=$2', [sessionRef, req.userId]);
  if (!v) throw new HttpError(404, 'Session not found');
  const dob = verifiedDob || (v.kind === 'age_id' ? (req.user.dob ? new Date(req.user.dob).toISOString().slice(0, 10) : null) : null);
  res.json(await verification.applyResult({ sessionRef, result: result === 'rejected' ? 'rejected' : 'verified', verifiedDob: dob, over18: dob ? undefined : true, reason: result === 'rejected' ? 'dev_rejected' : null }));
}));

module.exports = router;
module.exports.router = router;
