// Razorpay integration. Paid access exists ONLY as rows in entitlement_grants /
// users.boost_credits created here, after (a) a verified signature + an
// independent fetch of the payment from Razorpay, and/or (b) a signed webhook.
// Everything is idempotent: a replayed callback or webhook changes nothing.
const crypto = require('crypto');
const { one, many, query, tx } = require('../db');
const cfg = require('../config');
const { HttpError, hmacHex, timingSafeEqualStr, sha256 } = require('../lib/util');
const { refreshUserPlan } = require('../lib/entitlements');
const { notify } = require('../lib/notify');
const { audit } = require('../lib/audit');
const logger = require('../lib/logger');

// ---------- Razorpay REST client (replaceable in tests / dev) ----------
const API = 'https://api.razorpay.com/v1';
const realClient = {
  async call(method, path, body) {
    const id = process.env.RAZORPAY_KEY_ID, secret = process.env.RAZORPAY_KEY_SECRET;
    if (!id || !secret) throw new HttpError(501, 'Payments are not configured on this server.', { code: 'payments_not_configured' });
    const res = await fetch(API + path, {
      method, headers: { Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'), 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { logger.warn({ status: res.status, err: j?.error?.description }, 'razorpay error'); throw new HttpError(502, 'Payment provider error: ' + (j?.error?.description || res.status)); }
    return j;
  },
  createOrder: (o) => realClient.call('POST', '/orders', o),
  createPlan: (o) => realClient.call('POST', '/plans', o),
  createSubscription: (o) => realClient.call('POST', '/subscriptions', o),
  fetchPayment: (id) => realClient.call('GET', `/payments/${encodeURIComponent(id)}`),
  cancelSubscription: (id, atEnd) => realClient.call('POST', `/subscriptions/${encodeURIComponent(id)}/cancel`, { cancel_at_cycle_end: atEnd ? 1 : 0 }),
  refund: (paymentId, amount) => realClient.call('POST', `/payments/${encodeURIComponent(paymentId)}/refund`, amount ? { amount } : {}),
};
// Non-production stand-in so the UI can be exercised without Razorpay credentials.
const devClient = {
  createOrder: async (o) => ({ id: 'order_dev_' + crypto.randomBytes(6).toString('hex'), amount: o.amount, currency: o.currency }),
  createPlan: async () => ({ id: 'plan_dev_' + crypto.randomBytes(4).toString('hex') }),
  createSubscription: async () => ({ id: 'sub_dev_' + crypto.randomBytes(6).toString('hex'), status: 'created' }),
  fetchPayment: async (id) => ({ id, status: 'captured' }),
  cancelSubscription: async () => ({ status: 'cancelled' }),
  refund: async () => ({ id: 'rfnd_dev' }),
};
let override = null;
function setClient(c) { override = c; }
function client() {
  if (override) return override;
  if (!cfg.isProd() && process.env.PAYMENTS_DEV_MODE === 'true') return devClient;
  return realClient;
}
const keyId = () => process.env.RAZORPAY_KEY_ID || (process.env.PAYMENTS_DEV_MODE === 'true' && !cfg.isProd() ? 'rzp_dev' : null);

function product(key) {
  const p = cfg.PRODUCTS[key];
  if (!p) throw new HttpError(400, 'Unknown product', { code: 'unknown_product' });
  if (p.optional && !cfg.DAY_PASS_ENABLED()) throw new HttpError(400, 'That product is not available.', { code: 'unknown_product' });
  return p;
}

function listProducts() {
  return Object.entries(cfg.PRODUCTS)
    .filter(([, p]) => !p.optional || cfg.DAY_PASS_ENABLED())
    .map(([key, p]) => ({ key, kind: p.kind, plan: p.plan || null, months: p.months || null, credits: p.credits || null, hours: p.hours || null,
      amount: p.amount, priceInr: p.amount / 100, label: p.label,
      perMonthInr: p.months && p.months > 1 ? Math.round(p.amount / 100 / p.months) : undefined }));
}

async function ensurePlan(key, p) {
  const row = await one('SELECT * FROM razorpay_plans WHERE product_key=$1 AND amount=$2', [key, p.amount]);
  if (row) return row.razorpay_plan_id;
  const plan = await client().createPlan({ period: 'monthly', interval: 1, item: { name: `${cfg.BRAND_NAME} ${p.label}`, amount: p.amount, currency: 'INR' } });
  await query(`INSERT INTO razorpay_plans (product_key, razorpay_plan_id, amount) VALUES ($1,$2,$3)
               ON CONFLICT (product_key) DO UPDATE SET razorpay_plan_id=EXCLUDED.razorpay_plan_id, amount=EXCLUDED.amount`, [key, plan.id, p.amount]);
  return plan.id;
}

async function checkout(user, productKey) {
  const p = product(productKey);
  const kid = keyId();
  if (!kid) throw new HttpError(501, 'Payments are not configured on this server.', { code: 'payments_not_configured' });
  if (p.kind === 'subscription') {
    const active = await one(`SELECT * FROM subscriptions WHERE user_id=$1 AND status IN ('active','authenticated') AND cancel_at_period_end=false`, [user.id]);
    if (active) throw new HttpError(409, 'You already have an active subscription. Cancel it first to switch plans.', { code: 'already_subscribed' });
    const planId = await ensurePlan(productKey, p);
    const sub = await client().createSubscription({ plan_id: planId, total_count: 120, customer_notify: 1, notes: { userId: String(user.id), productKey } });
    await query(`INSERT INTO subscriptions (user_id, product_key, plan, razorpay_subscription_id, status) VALUES ($1,$2,$3,$4,'created')`, [user.id, productKey, p.plan, sub.id]);
    await query(`INSERT INTO payments (user_id, product_key, kind, amount, razorpay_subscription_id) VALUES ($1,$2,'subscription',$3,$4)`, [user.id, productKey, p.amount, sub.id]);
    return { type: 'subscription', keyId: kid, subscriptionId: sub.id, amount: p.amount, name: cfg.BRAND_NAME, description: p.label };
  }
  const receipt = `mf_${user.id}_${Date.now()}`.slice(0, 40);
  const order = await client().createOrder({ amount: p.amount, currency: 'INR', receipt, notes: { userId: String(user.id), productKey } });
  await query(`INSERT INTO payments (user_id, product_key, kind, amount, razorpay_order_id, receipt) VALUES ($1,$2,$3,$4,$5,$6)`, [user.id, productKey, p.kind, p.amount, order.id, receipt]);
  return { type: 'order', keyId: kid, orderId: order.id, amount: p.amount, currency: 'INR', name: cfg.BRAND_NAME, description: p.label };
}

// ---------- fulfilment (idempotent) ----------
async function addGrant(c, userId, plan, months, source, paymentId) {
  await c.query(
    `INSERT INTO entitlement_grants (user_id, plan, starts_at, ends_at, source, payment_id)
     SELECT $1, $2, s.st, s.st + ($3 || ' months')::interval, $4, $5
       FROM (SELECT GREATEST(NOW(), COALESCE((SELECT MAX(ends_at) FROM entitlement_grants WHERE user_id=$1 AND plan=$2 AND revoked_at IS NULL), NOW())) AS st) s`,
    [userId, plan, String(months), source, paymentId]);
}

async function fulfillOrderPayment(paymentRowId, razorpayPaymentId) {
  const result = await tx(async (c) => {
    const row = (await c.query(
      `UPDATE payments SET status='paid', razorpay_payment_id=$2, fulfilled_at=NOW() WHERE id=$1 AND fulfilled_at IS NULL AND status IN ('created','failed') RETURNING *`,
      [paymentRowId, razorpayPaymentId])).rows[0];
    if (!row) return null;                       // already fulfilled (replay) → no-op
    const p = cfg.PRODUCTS[row.product_key];
    if (p.kind === 'pack') await addGrant(c, row.user_id, p.plan, p.months, 'pack:' + row.product_key, row.id);
    else if (p.kind === 'boost') await c.query('UPDATE users SET boost_credits = boost_credits + $2 WHERE id=$1', [row.user_id, p.credits]);
    else if (p.kind === 'pass') await c.query(
      `INSERT INTO entitlement_grants (user_id, plan, starts_at, ends_at, source, payment_id) VALUES ($1,$2,NOW(), NOW() + ($3 || ' hours')::interval,'pass',$4)`,
      [row.user_id, p.plan, String(p.hours), row.id]);
    return row;
  });
  if (!result) return { fulfilled: false };
  await refreshUserPlan(result.user_id);
  notify(result.user_id, { type: 'payment', title: 'Payment received ✓', body: cfg.PRODUCTS[result.product_key].label + ' is now active.' }).catch(() => {});
  return { fulfilled: true, productKey: result.product_key };
}

// ---------- client callback ----------
async function verifyClientPayment(user, b) {
  const { razorpay_payment_id: paymentId, razorpay_order_id: orderId, razorpay_subscription_id: subId, razorpay_signature: signature } = b || {};
  if (!paymentId || !signature || (!orderId && !subId)) throw new HttpError(400, 'razorpay_payment_id, razorpay_signature and an order or subscription id are required');
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret) throw new HttpError(501, 'Payments are not configured on this server.', { code: 'payments_not_configured' });
  const payload = orderId ? `${orderId}|${paymentId}` : `${paymentId}|${subId}`;
  if (!timingSafeEqualStr(String(signature), hmacHex(secret, payload))) throw new HttpError(400, 'Payment signature is invalid.', { code: 'bad_signature' });

  if (orderId) {
    const row = await one('SELECT * FROM payments WHERE razorpay_order_id=$1 AND user_id=$2', [orderId, user.id]);
    if (!row) throw new HttpError(404, 'Order not found');
    const rp = await client().fetchPayment(paymentId);               // independent confirmation
    if (rp.order_id && rp.order_id !== orderId) throw new HttpError(400, 'Payment does not belong to this order.');
    if (rp.amount != null && Number(rp.amount) !== row.amount) throw new HttpError(400, 'Payment amount mismatch.');
    if (rp.status !== 'captured') return { status: 'pending', message: 'Payment is being processed. Your plan will activate shortly.' };
    const r = await fulfillOrderPayment(row.id, paymentId);
    return { status: 'paid', ...r };
  }
  const sub = await one('SELECT * FROM subscriptions WHERE razorpay_subscription_id=$1 AND user_id=$2', [subId, user.id]);
  if (!sub) throw new HttpError(404, 'Subscription not found');
  const rp = await client().fetchPayment(paymentId);
  if (!['captured', 'authorized'].includes(rp.status)) return { status: 'pending' };
  // Access is granted by the signed `subscription.activated/charged` webhook (authoritative billing period).
  return { status: 'pending', message: 'Subscription is being activated. This usually takes a few seconds.' };
}

// ---------- webhooks ----------
async function handleWebhook(rawBody, signature, eventIdHeader) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) throw new HttpError(501, 'Webhook secret not configured');
  if (!signature || !timingSafeEqualStr(String(signature), hmacHex(secret, rawBody))) throw new HttpError(400, 'Invalid webhook signature', { code: 'bad_signature' });
  let evt; try { evt = JSON.parse(rawBody.toString('utf8')); } catch (e) { throw new HttpError(400, 'Invalid JSON'); }
  const eventId = eventIdHeader || sha256(rawBody);
  const fresh = await one(`INSERT INTO webhook_events (id, provider, event) VALUES ($1,'razorpay',$2) ON CONFLICT DO NOTHING RETURNING id`, [eventId, evt.event]);
  if (!fresh) return { replay: true };
  try {
    await routeEvent(evt);
  } catch (e) {
    await query('DELETE FROM webhook_events WHERE id=$1', [eventId]);      // let Razorpay retry
    throw e;
  }
  return { ok: true };
}

async function routeEvent(evt) {
  const pl = evt.payload || {};
  const pay = pl.payment?.entity, order = pl.order?.entity, sub = pl.subscription?.entity, refund = pl.refund?.entity;
  switch (evt.event) {
    case 'payment.captured':
    case 'order.paid': {
      const orderId = pay?.order_id || order?.id;
      if (!orderId) return;
      const row = await one('SELECT * FROM payments WHERE razorpay_order_id=$1', [orderId]);
      if (!row) return;
      const pid = pay?.id; if (!pid) return;
      if (pay.amount != null && Number(pay.amount) !== row.amount) { logger.warn({ orderId }, 'webhook amount mismatch'); return; }
      await fulfillOrderPayment(row.id, pid);
      return;
    }
    case 'payment.failed': {
      const orderId = pay?.order_id;
      if (orderId) await query(`UPDATE payments SET status='failed' WHERE razorpay_order_id=$1 AND status='created'`, [orderId]);
      return;
    }
    case 'subscription.activated':
    case 'subscription.charged':
    case 'subscription.authenticated':
    case 'subscription.pending':
    case 'subscription.halted':
    case 'subscription.cancelled':
    case 'subscription.completed':
    case 'subscription.paused':
    case 'subscription.resumed': {
      if (!sub?.id) return;
      const row = await one('SELECT * FROM subscriptions WHERE razorpay_subscription_id=$1', [sub.id]);
      if (!row) return;
      const status = evt.event.split('.')[1] === 'charged' ? 'active' : sub.status || evt.event.split('.')[1];
      const periodEnd = sub.current_end ? new Date(sub.current_end * 1000) : null;
      await query(`UPDATE subscriptions SET status=$2, current_period_end=COALESCE($3, current_period_end), updated_at=NOW() WHERE id=$1`, [row.id, status, periodEnd]);
      if (['subscription.activated', 'subscription.charged'].includes(evt.event) && periodEnd && periodEnd > new Date()) {
        const source = `sub:${sub.id}:${periodEnd.toISOString()}`;
        await tx(async (c) => {
          const dup = await c.query('SELECT 1 FROM entitlement_grants WHERE user_id=$1 AND source=$2', [row.user_id, source]);
          if (dup.rowCount) return;
          let payId = null;
          if (pay?.id) {
            const pr = await c.query(`INSERT INTO payments (user_id, product_key, kind, amount, status, razorpay_subscription_id, razorpay_payment_id, fulfilled_at)
                                      VALUES ($1,$2,'subscription',$3,'paid',$4,$5,NOW()) ON CONFLICT (razorpay_payment_id) DO NOTHING RETURNING id`,
              [row.user_id, row.product_key, Number(pay.amount) || cfg.PRODUCTS[row.product_key].amount, sub.id, pay.id]);
            payId = pr.rows[0]?.id || null;
          }
          await c.query(`INSERT INTO entitlement_grants (user_id, plan, starts_at, ends_at, source, payment_id) VALUES ($1,$2,NOW(),$3,$4,$5)`,
            [row.user_id, row.plan, periodEnd, source, payId]);
          await c.query(`UPDATE users SET billing_cycle='monthly', autopay=true WHERE id=$1`, [row.user_id]);
        });
        await refreshUserPlan(row.user_id);
        notify(row.user_id, { type: 'payment', title: `${cfg.BRAND_NAME} ${row.plan} is active ✓`, body: 'Thanks for subscribing!' }).catch(() => {});
      }
      if (['subscription.cancelled', 'subscription.completed', 'subscription.halted'].includes(evt.event)) {
        await query('UPDATE users SET autopay=false WHERE id=$1', [row.user_id]);
      }
      return;
    }
    case 'refund.processed': {
      const pid = refund?.payment_id;
      if (!pid) return;
      const row = await one('SELECT * FROM payments WHERE razorpay_payment_id=$1', [pid]);
      if (!row || row.status === 'refunded') return;
      await query(`UPDATE payments SET status='refunded', refunded_at=NOW() WHERE id=$1`, [row.id]);
      await query('UPDATE entitlement_grants SET revoked_at=NOW() WHERE payment_id=$1', [row.id]);
      const p = cfg.PRODUCTS[row.product_key];
      if (p?.kind === 'boost') await query('UPDATE users SET boost_credits = GREATEST(0, boost_credits - $2) WHERE id=$1', [row.user_id, p.credits]);
      if (row.user_id) await refreshUserPlan(row.user_id);
      return;
    }
    default: return;
  }
}

// ---------- user-facing helpers ----------
async function cancelSubscription(user) {
  const sub = await one(`SELECT * FROM subscriptions WHERE user_id=$1 AND status IN ('active','authenticated') AND cancel_at_period_end=false ORDER BY created_at DESC LIMIT 1`, [user.id]);
  if (!sub) throw new HttpError(404, 'You have no active subscription.');
  await client().cancelSubscription(sub.razorpay_subscription_id, true);
  await query('UPDATE subscriptions SET cancel_at_period_end=true, updated_at=NOW() WHERE id=$1', [sub.id]);
  await query('UPDATE users SET autopay=false WHERE id=$1', [user.id]);
  return { ok: true, accessUntil: sub.current_period_end };
}
async function cancelAllSubscriptions(userId) {
  const subs = await many(`SELECT * FROM subscriptions WHERE user_id=$1 AND status IN ('active','authenticated','created') AND cancel_at_period_end=false`, [userId]);
  for (const s of subs) { try { await client().cancelSubscription(s.razorpay_subscription_id, false); } catch (e) { logger.warn({ err: e.message }, 'cancel sub failed'); } }
  await query(`UPDATE subscriptions SET status='cancelled', cancel_at_period_end=true WHERE user_id=$1`, [userId]);
}
async function mySubscription(userId) {
  return one(`SELECT product_key, plan, status, current_period_end, cancel_at_period_end FROM subscriptions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`, [userId]);
}
async function history(userId) {
  return many(`SELECT id, product_key, kind, amount, currency, status, created_at FROM payments WHERE user_id=$1 AND status <> 'created' ORDER BY created_at DESC LIMIT 100`, [userId]);
}

// Admin refund. Access is revoked when Razorpay confirms via refund.processed.
async function refundPayment(actor, paymentRowId, ip) {
  const row = await one('SELECT * FROM payments WHERE id=$1', [paymentRowId]);
  if (!row || row.status !== 'paid' || !row.razorpay_payment_id) throw new HttpError(400, 'Only paid payments can be refunded.');
  await client().refund(row.razorpay_payment_id, row.amount);
  await audit(actor, 'payment.refund', 'payment', row.id, { amount: row.amount }, ip);
  if (!cfg.isProd() && process.env.PAYMENTS_DEV_MODE === 'true') {
    await routeEvent({ event: 'refund.processed', payload: { refund: { entity: { payment_id: row.razorpay_payment_id } } } });
  }
  return { ok: true };
}

// Downgrade expired plans (also runs from the job scheduler).
async function sweepExpired() {
  const users = await many(`SELECT id FROM users WHERE plan <> 'free' AND plan_expires_at IS NOT NULL AND plan_expires_at < NOW()`);
  for (const u of users) await refreshUserPlan(u.id);
  return users.length;
}

module.exports = { setClient, client, keyId, listProducts, checkout, verifyClientPayment, handleWebhook, fulfillOrderPayment, cancelSubscription, cancelAllSubscriptions, mySubscription, history, refundPayment, sweepExpired, routeEvent };
