// "generic" provider: bring-your-own verification vendor (HyperVerge, IDfy, Signzy, Digio, …)
// behind a tiny adapter service you control. We POST a session request to
// VERIFICATION_START_URL and receive results on /api/verification/webhook
// signed with the same HMAC scheme as the mock provider.
//
//   POST {VERIFICATION_START_URL}  Authorization: Bearer {VERIFICATION_API_KEY}
//     body: { sessionRef, kind, userId, callbackUrl }   →   { redirectUrl }
const mock = require('./mock');

module.exports = {
  name: 'generic',
  async createSession({ user, kind, sessionRef }) {
    const url = process.env.VERIFICATION_START_URL;
    if (!url) throw Object.assign(new Error('VERIFICATION_START_URL is not configured'), { status: 501 });
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (process.env.VERIFICATION_API_KEY || '') },
      body: JSON.stringify({ sessionRef, kind, userId: user.id, callbackUrl: (process.env.APP_ORIGIN || '') + '/api/verification/webhook' }),
    });
    if (!res.ok) throw Object.assign(new Error('Verification provider error ' + res.status), { status: 502 });
    const j = await res.json();
    if (!j.redirectUrl) throw Object.assign(new Error('Provider did not return redirectUrl'), { status: 502 });
    return { redirectUrl: j.redirectUrl };
  },
  parseWebhook: mock.parseWebhook,
};
