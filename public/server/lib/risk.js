// Explainable risk signals → score → level. Users are never shown the score.
const { one, many, query } = require('../db');
const { audit } = require('./audit');

const WEIGHTS = {
  duplicate_photo: 40, signup_velocity: 25, disposable_email: 20, ip_country_mismatch: 10,
  high_swipe_rate: 15, repeated_message: 30, offplatform_early: 15, money_request: 25,
  report_rate: 20, photo_mismatch: 30, ai_scam_suspected: 20, underage_claim: 50,
  sensitive_credentials: 20, crypto_invest: 20,
};
const levelOf = (score) => (score >= 60 ? 'high' : score >= 30 ? 'medium' : 'low');

async function recordSignal(userId, signal, meta = {}, opts = {}) {
  const weight = opts.weight ?? WEIGHTS[signal] ?? 10;
  const dedupeMin = opts.dedupeMinutes ?? 60;
  const dup = await one(
    `SELECT 1 FROM risk_signals WHERE user_id=$1 AND signal=$2 AND created_at > NOW() - ($3 || ' minutes')::interval LIMIT 1`,
    [userId, signal, String(dedupeMin)]);
  if (dup) return null;
  await query(`INSERT INTO risk_signals (user_id, signal, weight, meta) VALUES ($1,$2,$3,$4)`,
    [userId, signal, weight, JSON.stringify(meta)]);
  return recomputeRisk(userId);
}

async function recomputeRisk(userId) {
  const r = await one(`SELECT COALESCE(SUM(weight),0)::int AS s FROM risk_signals
                        WHERE user_id=$1 AND created_at > NOW() - INTERVAL '30 days'`, [userId]);
  const score = Math.min(100, r.s);
  const level = levelOf(score);
  const before = await one('SELECT risk_level, status, is_demo, role FROM users WHERE id=$1', [userId]);
  if (!before) return null;
  await query('UPDATE users SET risk_score=$2, risk_level=$3 WHERE id=$1', [userId, score, level]);
  // High risk → restrict + queue for a human. Never auto-restrict staff or demo rows.
  if (level === 'high' && before.risk_level !== 'high' && before.status === 'active' && !before.is_demo && before.role === 'user') {
    await query(`UPDATE users SET status='restricted', status_reason='auto_risk' WHERE id=$1`, [userId]);
    const signals = await many(`SELECT signal, weight, meta, created_at FROM risk_signals WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20`, [userId]);
    await query(`INSERT INTO reports (reporter_id, reported_id, reason, details, status, source, context, priority, evidence)
                 VALUES (NULL,$1,'auto_risk','Automatic: risk score reached HIGH','open','system','risk',1,$2)`,
      [userId, JSON.stringify({ score, signals })]);
    await audit(null, 'risk.auto_restrict', 'user', userId, { score });
    require('./realtime').disconnectUser?.(userId, 'restricted');
  }
  return { score, level };
}

async function explain(userId) {
  return many(`SELECT signal, weight, meta, created_at FROM risk_signals WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100`, [userId]);
}

module.exports = { recordSignal, recomputeRisk, explain, WEIGHTS, levelOf };
