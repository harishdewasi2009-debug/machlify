const test = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');
const cfg = require('../config');
const payments = require('../services/payments');
const { hmacHex } = require('../lib/util');
const tokens = require('../services/tokens');
const { request, app } = h;

const SECRET = 'rzp_test_secret', WH = 'whsec_razorpay_test';
let n = 0; const rp = {};      // razorpay-side payment records the fake "fetch" returns
const cancelled = [];
const fake = {
  createOrder: async (o) => ({ id: 'order_' + (++n), amount: o.amount, currency: o.currency }),
  createPlan: async () => ({ id: 'plan_' + (++n) }),
  createSubscription: async () => ({ id: 'sub_' + (++n), status: 'created' }),
  fetchPayment: async (id) => { if (!rp[id]) throw new Error('unknown payment'); return rp[id]; },
  cancelSubscription: async (id) => { cancelled.push(id); return {}; },
  refund: async () => ({ id: 'rfnd_1' }),
};
test.before(async () => { await h.setup(); payments.setClient(fake); });
test.after(async () => { payments.setClient(null); await h.teardown(); });
test.beforeEach(async () => { await h.resetDb(); });

const sign = (order, pay) => hmacHex(SECRET, `${order}|${pay}`);
const refresh = async (u) => { u.token = tokens.signAccess(await h.fresh(u.id)); return (await h.fresh(u.id)); };
async function buy(u, productKey, { status = 'captured', payId } = {}) {
  const co = await h.as(u).post('/api/payments/checkout', { productKey });
  assert.strictEqual(co.status, 200, JSON.stringify(co.body));
  const pid = payId || 'pay_' + (++n);
  rp[pid] = { id: pid, order_id: co.body.orderId, amount: co.body.amount, status };
  return { co: co.body, pid, verify: (over = {}) => h.as(u).post('/api/payments/verify', { razorpay_order_id: co.body.orderId, razorpay_payment_id: pid, razorpay_signature: sign(co.body.orderId, pid), ...over }) };
}
const webhook = (body, { secret = WH, id = 'evt_' + (++n) } = {}) => {
  const raw = JSON.stringify(body);
  return request(app).post('/api/payments/webhook').set('Content-Type', 'application/json').set('x-razorpay-signature', hmacHex(secret, raw)).set('x-razorpay-event-id', id).send(raw);
};
const grants = async (uid) => (await h.db.query('SELECT * FROM entitlement_grants WHERE user_id=$1 ORDER BY id', [uid])).rows;

test('catalogue: INR prices for Plus/Premium/Pro, 3/6/12-month packs and boosts; day pass hidden by default', async () => {
  const u = await h.createUser();
  const r = await h.as(u).get('/api/payments/plans');
  const by = Object.fromEntries(r.body.products.map((p) => [p.key, p]));
  assert.deepStrictEqual([by.plus_monthly.priceInr, by.premium_monthly.priceInr, by.pro_monthly.priceInr], [199, 399, 699]);
  assert.deepStrictEqual([by.premium_3m.priceInr, by.premium_6m.priceInr, by.premium_12m.priceInr], [999, 1599, 2499]);
  assert.ok(by.premium_12m.perMonthInr < by.premium_6m.perMonthInr && by.premium_6m.perMonthInr < by.premium_3m.perMonthInr && by.premium_3m.perMonthInr < by.premium_monthly.priceInr);
  assert.ok(by.boost_1 && by.boost_3 && by.boost_5); assert.strictEqual(by.day_pass, undefined);
  assert.strictEqual((await h.as(u).post('/api/payments/checkout', { productKey: 'day_pass' })).status, 400);
  assert.strictEqual((await h.as(u).post('/api/payments/checkout', { productKey: 'free_forever' })).status, 400);
});

test('valid signature + Razorpay-confirmed capture activates a prepaid pack; entitlements switch on', async () => {
  const u = await h.createUser({ gender: 'man' });
  const b = await buy(u, 'premium_3m');
  assert.strictEqual((await h.fresh(u.id)).plan, 'free', 'nothing granted at checkout time');
  const r = await b.verify();
  assert.strictEqual(r.status, 200); assert.strictEqual(r.body.status, 'paid');
  const row = await refresh(u);
  assert.strictEqual(row.plan, 'premium');
  const days = (new Date(row.plan_expires_at) - Date.now()) / 864e5; assert.ok(days > 88 && days < 93, 'about 3 months: ' + days);
  assert.strictEqual((await h.as(u).get('/api/users/likes-you')).body.locked, false, 'Premium can see likes');
  assert.strictEqual((await h.db.query('SELECT status FROM payments')).rows[0].status, 'paid');
});

test('replayed callbacks are idempotent; packs stack end-to-end', async () => {
  const u = await h.createUser();
  const b = await buy(u, 'premium_3m');
  await b.verify(); const again = await b.verify();
  assert.strictEqual(again.body.fulfilled, false); assert.strictEqual((await grants(u.id)).length, 1);
  const b2 = await buy(u, 'premium_3m'); await b2.verify();
  const g = await grants(u.id); assert.strictEqual(g.length, 2);
  assert.ok(new Date(g[1].starts_at) >= new Date(g[0].ends_at) - 2000, 'second pack starts when the first ends');
  const row = await h.fresh(u.id); assert.ok((new Date(row.plan_expires_at) - Date.now()) / 864e5 > 175, 'about 6 months total');
});

test('forged / mismatched payments grant nothing', async () => {
  const [u, other] = [await h.createUser(), await h.createUser()];
  const b = await buy(u, 'premium_12m');
  assert.strictEqual((await b.verify({ razorpay_signature: hmacHex('wrong-secret', `${b.co.orderId}|${b.pid}`) })).status, 400, 'bad signature');
  assert.strictEqual((await b.verify({ razorpay_signature: 'deadbeef' })).status, 400);
  assert.strictEqual((await h.as(other).post('/api/payments/verify', { razorpay_order_id: b.co.orderId, razorpay_payment_id: b.pid, razorpay_signature: sign(b.co.orderId, b.pid) })).status, 404, "someone else's order");
  // a real ₹49 boost payment replayed against an expensive order
  const cheap = await buy(u, 'boost_1'); const exp = await buy(u, 'premium_12m');
  rp[cheap.pid].order_id = cheap.co.orderId;
  const swap = await h.as(u).post('/api/payments/verify', { razorpay_order_id: exp.co.orderId, razorpay_payment_id: cheap.pid, razorpay_signature: sign(exp.co.orderId, cheap.pid) });
  assert.strictEqual(swap.status, 400, 'payment belongs to a different order');
  rp[exp.pid].amount = 100;
  assert.strictEqual((await exp.verify()).status, 400, 'amount mismatch');
  const auth = await buy(u, 'premium_3m', { status: 'authorized' });
  assert.strictEqual((await auth.verify()).body.status, 'pending', 'authorized-but-not-captured is not fulfilled');
  assert.strictEqual((await h.fresh(u.id)).plan, 'free'); assert.strictEqual((await grants(u.id)).length, 0);
});

test('boost packs add credits once', async () => {
  const u = await h.createUser();
  const b = await buy(u, 'boost_3'); await b.verify(); await b.verify();
  assert.strictEqual((await h.fresh(u.id)).boost_credits, 3);
  const r = await h.as(u).post('/api/users/me/boost'); assert.strictEqual(r.status, 200);
});

test('webhook: bad/missing/forged signatures rejected; valid capture fulfils; replays and duplicates are harmless', async () => {
  const u = await h.createUser();
  const b = await buy(u, 'premium_6m');
  const evt = { event: 'payment.captured', payload: { payment: { entity: { id: b.pid, order_id: b.co.orderId, amount: b.co.amount, status: 'captured' } } } };
  assert.strictEqual((await request(app).post('/api/payments/webhook').set('Content-Type', 'application/json').send(JSON.stringify(evt))).status, 400, 'no signature');
  assert.strictEqual((await webhook(evt, { secret: 'attacker-secret' })).status, 400, 'forged signature');
  assert.strictEqual((await h.fresh(u.id)).plan, 'free');
  const ok = await webhook(evt, { id: 'evt_A' }); assert.strictEqual(ok.status, 200);
  assert.strictEqual((await h.fresh(u.id)).plan, 'premium');
  const replay = await webhook(evt, { id: 'evt_A' }); assert.strictEqual(replay.body.replay, true);
  await webhook(evt, { id: 'evt_B' });                                         // same payment, new event id
  await webhook({ event: 'order.paid', payload: { order: { entity: { id: b.co.orderId } }, payment: { entity: { id: b.pid, order_id: b.co.orderId, amount: b.co.amount } } } });
  assert.strictEqual((await grants(u.id)).length, 1, 'still exactly one grant');
  const wrongAmount = await buy(u, 'boost_5');
  await webhook({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_x', order_id: wrongAmount.co.orderId, amount: 1 } } } });
  assert.strictEqual((await h.fresh(u.id)).boost_credits, 0, 'amount mismatch ignored');
});

test('subscriptions: activation via signed webhooks (out-of-order safe), no duplicate grants, cancel keeps access until period end', async () => {
  const u = await h.createUser();
  const co = await h.as(u).post('/api/payments/checkout', { productKey: 'plus_monthly' });
  assert.strictEqual(co.body.type, 'subscription'); const subId = co.body.subscriptionId;
  assert.strictEqual((await h.as(u).post('/api/payments/checkout', { productKey: 'pro_monthly' })).status, 200, 'a second pending checkout is allowed until one activates');
  const end = Math.floor(Date.now() / 1000) + 30 * 86400;
  const charged = { event: 'subscription.charged', payload: { subscription: { entity: { id: subId, status: 'active', current_end: end } }, payment: { entity: { id: 'pay_sub1', amount: 19900 } } } };
  await webhook(charged);                                                        // arrives BEFORE activated
  await webhook({ event: 'subscription.activated', payload: { subscription: { entity: { id: subId, status: 'active', current_end: end } } } });
  assert.strictEqual((await h.fresh(u.id)).plan, 'plus');
  assert.strictEqual((await grants(u.id)).length, 1, 'same period is never granted twice');
  assert.strictEqual((await h.fresh(u.id)).autopay, true);
  u.token = tokens.signAccess(await h.fresh(u.id));
  assert.strictEqual((await h.as(u).post('/api/payments/checkout', { productKey: 'premium_monthly' })).status, 409, 'cannot start another subscription while one is active');
  const c = await h.as(u).post('/api/payments/subscription/cancel');
  assert.strictEqual(c.status, 200); assert.deepStrictEqual(cancelled, [subId]);
  assert.strictEqual((await h.fresh(u.id)).plan, 'plus', 'paid period is honoured');
  assert.strictEqual((await h.fresh(u.id)).autopay, false);
  await webhook({ event: 'subscription.cancelled', payload: { subscription: { entity: { id: subId, status: 'cancelled', current_end: end } } } });
  assert.strictEqual((await h.fresh(u.id)).plan, 'plus');
  // next billing period
  const end2 = end + 30 * 86400;
  await webhook({ event: 'subscription.charged', payload: { subscription: { entity: { id: subId, status: 'active', current_end: end2 } }, payment: { entity: { id: 'pay_sub2', amount: 19900 } } } });
  assert.strictEqual((await grants(u.id)).length, 2);
  assert.strictEqual((await h.as(u).get('/api/payments/history')).body.payments.filter((p) => p.status === 'paid').length, 2);
});

test('refunds revoke access; expiry downgrades automatically', async () => {
  const u = await h.createUser();
  const b = await buy(u, 'premium_3m'); await b.verify();
  assert.strictEqual((await h.fresh(u.id)).plan, 'premium');
  await webhook({ event: 'refund.processed', payload: { refund: { entity: { payment_id: b.pid } } } });
  assert.strictEqual((await h.fresh(u.id)).plan, 'free');
  assert.strictEqual((await h.db.query('SELECT status FROM payments WHERE razorpay_payment_id=$1', [b.pid])).rows[0].status, 'refunded');
  const boosts = await buy(u, 'boost_3'); await boosts.verify();
  await webhook({ event: 'refund.processed', payload: { refund: { entity: { payment_id: boosts.pid } } } });
  assert.strictEqual((await h.fresh(u.id)).boost_credits, 0);
  // expiry
  const b2 = await buy(u, 'premium_3m'); await b2.verify();
  await h.db.query(`UPDATE entitlement_grants SET ends_at = NOW() - INTERVAL '1 day' WHERE user_id=$1 AND revoked_at IS NULL`, [u.id]);
  await h.db.query(`UPDATE users SET plan_expires_at = NOW() - INTERVAL '1 day' WHERE id=$1`, [u.id]);
  assert.strictEqual(require('../lib/entitlements').planOf(await h.fresh(u.id)), 'free', 'expired plan is treated as free immediately');
  assert.strictEqual(await payments.sweepExpired(), 1);
  const row = await h.fresh(u.id); assert.deepStrictEqual([row.plan, row.premium, row.plan_expires_at], ['free', false, null]);
});

test('there is NO way to self-upgrade: removed endpoint, ignored fields, dev endpoint disabled', async () => {
  const u = await h.createUser();
  assert.strictEqual((await h.as(u).post('/api/users/subscribe', { plan: 'pro', billing: 'monthly' })).status, 410);
  await h.as(u).put('/api/users/me', { plan: 'pro', premium: true, plan_expires_at: '2099-01-01', boostCredits: 99, boost_credits: 99, role: 'admin' });
  await h.as(u).put('/api/users/me/settings', { plan: 'pro', role: 'admin' });
  const row = await h.fresh(u.id);
  assert.deepStrictEqual([row.plan, row.premium, row.boost_credits, row.role], ['free', false, 0, 'user']);
  assert.strictEqual((await h.as(u).post('/api/payments/dev/complete', { orderId: 'order_1' })).status, 404);
  assert.strictEqual((await h.as(u).post('/api/admin/users/1/role', { role: 'admin' })).status, 403);
});

test('payments not configured → clear 501, never a silent success', async () => {
  const u = await h.createUser(); const k = process.env.RAZORPAY_KEY_ID; delete process.env.RAZORPAY_KEY_ID; payments.setClient(null);
  try { assert.strictEqual((await h.as(u).post('/api/payments/checkout', { productKey: 'boost_1' })).status, 501); }
  finally { process.env.RAZORPAY_KEY_ID = k; payments.setClient(fake); }
});
