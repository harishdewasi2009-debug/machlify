const { query } = require('../db');
async function audit(actor, action, targetType, targetId, meta = {}, ip = null) {
  await query(
    `INSERT INTO audit_log (actor_id, actor_role, action, target_type, target_id, meta, ip) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [actor?.id || null, actor?.role || 'system', action, targetType || null, targetId == null ? null : String(targetId), JSON.stringify(meta), ip]);
}
module.exports = { audit };
