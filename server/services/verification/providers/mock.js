// DEV/TEST ONLY. Refused in production (see services/verification/index.js).
const { hmacHex, timingSafeEqualStr } = require('../../../lib/util');

module.exports = {
  name: 'mock',
  async createSession({ sessionRef, kind }) {
    return { redirectUrl: `/verify-mock.html?ref=${sessionRef}&kind=${kind}` };
  },
  // Wire format shared with the `generic` provider:
  //   header  X-Verification-Signature: sha256=<hex HMAC-SHA256(secret, rawBody)>
  //   body    { sessionRef, result: 'verified'|'rejected', verifiedDob?, over18?, reason? }
  parseWebhook(rawBody, headers) {
    const secret = process.env.VERIFICATION_WEBHOOK_SECRET;
    if (!secret) return { error: 'VERIFICATION_WEBHOOK_SECRET is not configured', status: 501 };
    const sig = String(headers['x-verification-signature'] || '').replace(/^sha256=/, '');
    if (!sig || !timingSafeEqualStr(sig, hmacHex(secret, rawBody))) return { error: 'Invalid webhook signature', status: 401 };
    let b; try { b = JSON.parse(rawBody.toString('utf8')); } catch (e) { return { error: 'Invalid JSON', status: 400 }; }
    if (!b.sessionRef || !['verified', 'rejected'].includes(b.result)) return { error: 'sessionRef and result required', status: 400 };
    return { sessionRef: b.sessionRef, result: b.result, verifiedDob: b.verifiedDob || null, over18: b.over18, reason: b.reason || null, eventId: b.eventId || null };
  },
};
