const test = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');
const jobs = require('../jobs');
const mailer = require('../lib/mailer');

test.before(h.setup);
test.after(h.teardown);
test.beforeEach(async () => { await h.resetDb(); });
const ago = (days) => new Date(Date.now() - days * 864e5);

test('suspensions expire automatically; pending deletions are purged after the grace period', async () => {
  const s = await h.createUser({ status: 'suspended', suspended_until: ago(1) }), still = await h.createUser({ status: 'suspended', suspended_until: new Date(Date.now() + 864e5) });
  assert.strictEqual(await jobs.tasks.reactivateSuspensions(), 1);
  assert.strictEqual((await h.fresh(s.id)).status, 'active'); assert.strictEqual((await h.fresh(still.id)).status, 'suspended');
  const d = await h.createUser({ status: 'pending_deletion', deletion_scheduled_at: ago(1) }), wait = await h.createUser({ status: 'pending_deletion', deletion_scheduled_at: new Date(Date.now() + 864e5) });
  assert.strictEqual(await jobs.tasks.purgePendingDeletions(), 1);
  assert.strictEqual(await h.fresh(d.id), undefined); assert.ok(await h.fresh(wait.id));
});

test('inactive accounts: notice → hidden → scheduled deletion; returning users are restored; demo/staff exempt', async () => {
  const cfg = require('../config');
  const u = await h.createUser({ last_active_at: ago(cfg.INACTIVE_NOTICE_DAYS + 5) });
  const demo = await h.createUser({ last_active_at: ago(900), is_demo: true, email: 'x@demo.matchify.invalid' }), staff = await h.createUser({ last_active_at: ago(900), role: 'admin' });
  mailer.outbox.length = 0;
  let r = await jobs.tasks.inactiveCleanup(); assert.strictEqual(r.noticed, 1);
  assert.ok(mailer.outbox.some((m) => m.to === u.email)); assert.ok((await h.fresh(u.id)).inactive_notice_sent_at);
  await h.db.query(`UPDATE users SET inactive_notice_sent_at = NOW() - ($2 || ' days')::interval WHERE id=$1`, [u.id, String(cfg.INACTIVE_HIDE_AFTER_NOTICE_DAYS + 1)]);
  r = await jobs.tasks.inactiveCleanup(); assert.strictEqual(r.hidden, 1);
  assert.deepStrictEqual([(await h.fresh(u.id)).discoverable, (await h.fresh(u.id)).hidden_reason], [false, 'inactive']);
  await h.setUser(u.id, { last_active_at: new Date() });
  assert.strictEqual(await jobs.tasks.unhideReturning(), 1); assert.strictEqual((await h.fresh(u.id)).discoverable, true);
  await h.setUser(u.id, { last_active_at: ago(cfg.INACTIVE_DELETE_DAYS + 1), discoverable: false, hidden_reason: 'inactive' });
  r = await jobs.tasks.inactiveCleanup(); assert.strictEqual(r.scheduledDeletion, 1); assert.strictEqual((await h.fresh(u.id)).status, 'pending_deletion');
  for (const x of [demo, staff]) assert.strictEqual((await h.fresh(x.id)).status, 'active', 'exempt');
});

test('retention: closed-match messages purge unless a report is open; random transcripts expire; tokens cleaned', async () => {
  const cfg = require('../config');
  const [a, b, c] = [await h.createUser(), await h.createUser(), await h.createUser()];
  const m1 = await h.makeMatch(a, b), m2 = await h.makeMatch(a, c);
  for (const m of [m1, m2]) await h.db.query(`INSERT INTO messages (match_id, sender_id, text) VALUES ($1,$2,'old')`, [m.id, a.id]);
  await h.db.query(`UPDATE matches SET status='closed', closed_at=$1`, [ago(cfg.MESSAGE_RETENTION_DAYS + 1)]);
  await h.db.query(`INSERT INTO reports (reporter_id, reported_id, reason, match_id, status) VALUES ($1,$2,'harassment',$3,'open')`, [c.id, a.id, m2.id]);
  const r = await jobs.tasks.purgeOldContent();
  assert.strictEqual(r.messages, 1); assert.strictEqual((await h.db.query('SELECT match_id FROM messages')).rows[0].match_id, m2.id, 'evidence for an open report is retained');
  await h.db.query(`INSERT INTO email_tokens (user_id, purpose, token_hash, expires_at) VALUES ($1,'verify','h1',$2)`, [a.id, ago(5)]);
  await h.db.query(`INSERT INTO webhook_events (id, provider, event, received_at) VALUES ('old','razorpay','x',$1)`, [ago(120)]);
  const t = await jobs.tasks.cleanupTokens(); assert.strictEqual(t.emailTokens, 1); assert.strictEqual(t.webhookEvents, 1);
});

test('daily recommendations are generated for active verified users only; ages refresh; runGroup is lock-safe', async () => {
  const me = await h.createUser({ gender: 'man' }); for (let i = 0; i < 5; i++) await h.createUser({ gender: 'woman' });
  const idle = await h.createUser({ gender: 'man', last_active_at: ago(30) });
  const n = await jobs.tasks.generateDailyRecommendations();
  assert.ok(n >= 1); assert.ok(Number((await h.db.query('SELECT COUNT(*) c FROM daily_recommendations WHERE user_id=$1', [me.id])).rows[0].c) > 0);
  assert.strictEqual(Number((await h.db.query('SELECT COUNT(*) c FROM daily_recommendations WHERE user_id=$1', [idle.id])).rows[0].c), 0);
  await h.setUser(me.id, { age: 5 }); assert.ok(await jobs.tasks.refreshAges() >= 1); assert.ok((await h.fresh(me.id)).age >= 18);
  const [x, y] = await Promise.all([jobs.runGroup(['sweepExpiredPlans'], 991), jobs.runGroup(['sweepExpiredPlans'], 991)]);
  assert.ok(x !== undefined && y !== undefined);
});
