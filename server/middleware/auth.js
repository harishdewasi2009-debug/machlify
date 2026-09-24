const jwt = require('jsonwebtoken');
const { one, query } = require('../db');
const { REQUIRE_AGE_VERIFICATION } = require('../config');
const { HttpError, asyncHandler } = require('../lib/util');

function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

// Verify a JWT and load the live user row (checks token_version so "log out
// everywhere" and password resets revoke access tokens immediately).
async function authenticateToken(token) {
  if (!token) throw new HttpError(401, 'Missing auth token', { code: 'no_token' });
  let payload;
  try { payload = jwt.verify(token, process.env.JWT_SECRET); }
  catch (e) { throw new HttpError(401, 'Invalid or expired token', { code: 'invalid_token' }); }
  const user = await one('SELECT * FROM users WHERE id = $1', [payload.userId]);
  if (!user || user.token_version !== (payload.tv ?? 0)) throw new HttpError(401, 'Session expired', { code: 'invalid_token' });
  // Suspensions expire on their own.
  if (user.status === 'suspended' && user.suspended_until && new Date(user.suspended_until) < new Date()) {
    await query(`UPDATE users SET status='active', suspended_until=NULL, status_reason=NULL WHERE id=$1`, [user.id]);
    user.status = 'active';
  }
  return user;
}

function gateStatus(user, lenient) {
  if (user.status === 'banned' || user.status === 'deleted')
    throw new HttpError(403, 'This account has been banned.', { code: 'account_banned' });
  if (lenient) return;
  if (user.status === 'suspended')
    throw new HttpError(403, 'This account is suspended.', { code: 'account_suspended', until: user.suspended_until });
  if (user.status === 'pending_deletion')
    throw new HttpError(403, 'This account is scheduled for deletion. Log in and cancel the deletion to continue.', { code: 'pending_deletion' });
}

function makeAuth(lenient, any) {
  return asyncHandler(async (req, res, next) => {
    const user = await authenticateToken(bearer(req));
    if (!any) gateStatus(user, lenient);
    req.user = user; req.userId = user.id;
    // Throttled activity stamp.
    if (!user.last_active_at || Date.now() - new Date(user.last_active_at).getTime() > 60000) {
      query('UPDATE users SET last_active_at = NOW() WHERE id = $1', [user.id]).catch(() => {});
    }
    next();
  });
}
const requireAuth = makeAuth(false);
const requireAuthAny = makeAuth(true, true);   // even banned users may reach the appeals endpoint
const requireAuthLenient = makeAuth(true);   // suspended / pending-deletion users may still reach appeals, export, delete

// The 18+ gate. Discovery, swipes, matches, chat, calls, Random Talk, AI Talk.
// Demo rows get NO bypass here: a demo profile can never act as a user.
function checkVerified(user) {
  if (user.status === 'restricted')
    throw new HttpError(403, 'Your account is under review. Some features are unavailable.', { code: 'account_restricted' });
  if (user.status !== 'active')
    throw new HttpError(403, 'Account not active.', { code: 'account_inactive' });
  if (!user.dob && !user.age) throw new HttpError(403, 'Please add your date of birth first.', { code: 'dob_required' });
  if (REQUIRE_AGE_VERIFICATION() && user.verification_status !== 'verified')
    throw new HttpError(403, 'Age verification required before you can use matching, chat, calls or Random Talk.',
      { code: 'verification_required', verificationStatus: user.verification_status });
}
const requireVerified = (req, res, next) => {
  try { checkVerified(req.user); next(); } catch (e) { next(e); }
};

const requireRole = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) return next(new HttpError(403, 'Forbidden', { code: 'forbidden' }));
  next();
};

module.exports = { requireAuth, requireAuthLenient, requireAuthAny, requireVerified, requireRole, authenticateToken, checkVerified, bearer };
