// Google Identity Services: the browser sends an ID token ("credential");
// we verify signature, audience and expiry server-side.
let override = null;
let client = null;

function setVerifier(fn) { override = fn; }   // tests

async function verifyGoogleToken(idToken) {
  if (override) return override(idToken);
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) { const e = new Error('Google sign-in is not configured (GOOGLE_CLIENT_ID).'); e.status = 501; throw e; }
  if (!client) { const { OAuth2Client } = require('google-auth-library'); client = new OAuth2Client(clientId); }
  const ticket = await client.verifyIdToken({ idToken, audience: clientId });
  const p = ticket.getPayload();
  return { sub: p.sub, email: (p.email || '').toLowerCase(), emailVerified: !!p.email_verified, name: p.name || p.given_name || 'Friend' };
}
module.exports = { verifyGoogleToken, setVerifier };
