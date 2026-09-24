// Persona (withpersona.com) adapter — written against Persona's public API docs.
// NOT exercised against a live account in this repo: verify field names against
// your Persona dashboard/template before go-live (see README "Real vs mocked").
// Env: PERSONA_API_KEY, PERSONA_TEMPLATE_AGE (government ID + selfie template),
//      PERSONA_TEMPLATE_SELFIE (selfie/liveness template), VERIFICATION_WEBHOOK_SECRET.
const { hmacHex, timingSafeEqualStr } = require('../../../lib/util');
const API = 'https://withpersona.com/api/v1';
const hdr = () => ({ Authorization: 'Bearer ' + process.env.PERSONA_API_KEY, 'Content-Type': 'application/json', 'Persona-Version': '2023-01-05' });

module.exports = {
  name: 'persona',
  async createSession({ kind, sessionRef }) {
    const tpl = kind === 'photo_selfie' ? process.env.PERSONA_TEMPLATE_SELFIE : process.env.PERSONA_TEMPLATE_AGE;
    if (!process.env.PERSONA_API_KEY || !tpl) throw Object.assign(new Error('Persona is not configured'), { status: 501 });
    const r1 = await fetch(`${API}/inquiries`, { method: 'POST', headers: hdr(),
      body: JSON.stringify({ data: { attributes: { 'inquiry-template-id': tpl, 'reference-id': sessionRef } } }) });
    if (!r1.ok) throw Object.assign(new Error('Persona error ' + r1.status), { status: 502 });
    const id = (await r1.json()).data.id;
    const r2 = await fetch(`${API}/inquiries/${id}/generate-one-time-link`, { method: 'POST', headers: hdr(), body: '{}' });
    if (!r2.ok) throw Object.assign(new Error('Persona link error ' + r2.status), { status: 502 });
    const link = (await r2.json()).meta?.['one-time-link'];
    return { redirectUrl: link };
  },
  parseWebhook(rawBody, headers) {
    const secret = process.env.VERIFICATION_WEBHOOK_SECRET;
    if (!secret) return { error: 'VERIFICATION_WEBHOOK_SECRET is not configured', status: 501 };
    const parts = Object.fromEntries(String(headers['persona-signature'] || '').split(',').map((kv) => kv.split('=').map((x) => x.trim())));
    const t = parts.t, v1 = parts.v1;
    if (!t || !v1 || !timingSafeEqualStr(v1, hmacHex(secret, `${t}.${rawBody.toString('utf8')}`))) return { error: 'Invalid webhook signature', status: 401 };
    if (Math.abs(Date.now() / 1000 - Number(t)) > 600) return { error: 'Stale webhook', status: 401 };
    let b; try { b = JSON.parse(rawBody.toString('utf8')); } catch (e) { return { error: 'Invalid JSON', status: 400 }; }
    const name = b?.data?.attributes?.name || '';
    const inquiry = b?.data?.attributes?.payload?.data;
    const ref = inquiry?.attributes?.['reference-id'];
    if (!ref) return { error: 'No reference-id', status: 400 };
    if (!['inquiry.approved', 'inquiry.declined', 'inquiry.failed'].includes(name)) return { ignore: true };
    const included = b?.data?.attributes?.payload?.included || [];
    const bd = included.map((i) => i?.attributes?.birthdate).find(Boolean) || null;
    return { sessionRef: ref, result: name === 'inquiry.approved' ? 'verified' : 'rejected', verifiedDob: bd, reason: name === 'inquiry.approved' ? null : 'provider_declined', eventId: b?.data?.id };
  },
};
