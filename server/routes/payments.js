const express = require('express');
const { one, query } = require('../db');
const cfg = require('../config');
const { requireAuth } = require('../middleware/auth');
const limits = require('../middleware/limits');
const { HttpError, asyncHandler } = require('../lib/util');
const payments = require('../services/payments');
const { planOf } = require('../lib/entitlements');

const router = express.Router();

router.get('/plans', requireAuth, asyncHandler(async (req, res) => {
  res.json({
    products: payments.listProducts(),
    entitlements: cfg.PLAN_ENTITLEMENTS,
    current: { plan: planOf(req.user), expiresAt: req.user.plan_expires_at, boostCredits: req.user.boost_credits, subscription: await payments.mySubscription(req.userId) },
    keyId: payments.keyId(), gstNote: 'Prices are in INR and include applicable taxes.',
    devMode: !cfg.isProd() && process.env.PAYMENTS_DEV_MODE === 'true',
  });
}));

router.post('/checkout', requireAuth, limits.payments, asyncHandler(async (req, res) => {
  res.json(await payments.checkout(req.user, req.body?.productKey));
}));

router.post('/verify', requireAuth, limits.payments, asyncHandler(async (req, res) => {
  res.json(await payments.verifyClientPayment(req.user, req.body));
}));

// Raw body (see app.js). Razorpay retries on non-2xx; replays are harmless.
router.post('/webhook', asyncHandler(async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
  res.json(await payments.handleWebhook(raw, req.headers['x-razorpay-signature'], req.headers['x-razorpay-event-id']));
}));

router.post('/subscription/cancel', requireAuth, asyncHandler(async (req, res) => res.json(await payments.cancelSubscription(req.user))));
router.get('/history', requireAuth, asyncHandler(async (req, res) => res.json({ payments: await payments.history(req.userId) })));

// NON-PRODUCTION ONLY (PAYMENTS_DEV_MODE=true): completes a checkout without Razorpay so the UI can be tried locally.
router.post('/dev/complete', requireAuth, asyncHandler(async (req, res) => {
  if (cfg.isProd() || process.env.PAYMENTS_DEV_MODE !== 'true') throw new HttpError(404, 'Not found');
  const { orderId, subscriptionId } = req.body || {};
  if (orderId) {
    const row = await one('SELECT * FROM payments WHERE razorpay_order_id=$1 AND user_id=$2', [orderId, req.userId]);
    if (!row) throw new HttpError(404, 'Order not found');
    return res.json(await payments.fulfillOrderPayment(row.id, 'pay_dev_' + Date.now()));
  }
  if (subscriptionId) {
    const sub = await one('SELECT * FROM subscriptions WHERE razorpay_subscription_id=$1 AND user_id=$2', [subscriptionId, req.userId]);
    if (!sub) throw new HttpError(404, 'Subscription not found');
    const end = Math.floor(Date.now() / 1000) + 30 * 86400;
    await payments.routeEvent({ event: 'subscription.charged', payload: { subscription: { entity: { id: subscriptionId, status: 'active', current_end: end } },
      payment: { entity: { id: 'pay_dev_' + Date.now(), amount: cfg.PRODUCTS[sub.product_key].amount } } } });
    return res.json({ ok: true });
  }
  throw new HttpError(400, 'orderId or subscriptionId required');
}));

module.exports = router;
module.exports.router = router;
