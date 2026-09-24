const { one, many, query } = require('../db');
const cfg = require('../config');
const { HttpError } = require('../lib/util');
const { checkVerified } = require('../middleware/auth');
const { moderateText, warningFor, SUPPORT_TEXT } = require('../lib/moderation');
const { recordSignal } = require('../lib/risk');
const { emitToUser, isOnline } = require('../lib/realtime');
const { notify } = require('../lib/notify');

const sendLog = new Map(); // userId -> [timestamps]
function rateLimitSend(userId) {
  const now = Date.now();
  const arr = (sendLog.get(userId) || []).filter((t) => now - t < 60000);
  if (arr.length >= cfg.MESSAGES_PER_MINUTE) throw new HttpError(429, 'You are sending messages too quickly.', { code: 'rate_limited' });
  arr.push(now); sendLog.set(userId, arr);
}

// Active match this user belongs to, plus the other participant.
async function getActiveMatch(matchId, userId) {
  const m = await one(`SELECT * FROM matches WHERE id=$1 AND (user_a=$2 OR user_b=$2)`, [matchId, userId]);
  if (!m || m.status !== 'active') throw new HttpError(404, 'Match not found', { code: 'match_not_found' });
  const otherId = m.user_a === userId ? m.user_b : m.user_a;
  return { match: m, otherId };
}

// Enforced for every message/call/typing event: verified + not blocked + both active.
async function assertCanInteract(user, otherId) {
  checkVerified(user);
  const r = await one(
    `SELECT (SELECT COUNT(*) FROM blocks WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1)) AS blocked,
            (SELECT status FROM users WHERE id=$2) AS other_status`, [user.id, otherId]);
  if (Number(r.blocked) > 0) throw new HttpError(403, 'You cannot interact with this user.', { code: 'blocked' });
  if (r.other_status !== 'active' && r.other_status !== 'restricted') throw new HttpError(403, 'This user is unavailable.', { code: 'unavailable' });
}

function serializeMessage(m, viewerId, receiptsVisible) {
  const mine = m.sender_id === viewerId;
  const out = { id: m.id, matchId: m.match_id, senderId: m.sender_id, text: m.text, type: m.type, createdAt: m.created_at, clientId: m.client_id || undefined };
  if (mine && receiptsVisible) { out.delivered = !!m.delivered_at; out.read = !!m.read_at; }
  if (!mine && m.moderation_flag === 'flagged') out.warning = warningFor(m.moderation_reasons || []) || 'Be careful with this message.';
  return out;
}

async function receiptsVisible(userId, otherId) {
  const r = await one('SELECT (SELECT read_receipts FROM users WHERE id=$1) a, (SELECT read_receipts FROM users WHERE id=$2) b', [userId, otherId]);
  return !!(r.a && r.b);
}

async function sendMessage(user, matchId, rawText, { clientId } = {}) {
  const text = String(rawText ?? '').trim();
  if (!text) throw new HttpError(400, 'Message cannot be empty');
  if (text.length > cfg.MESSAGE_MAX_LENGTH) throw new HttpError(400, `Messages are limited to ${cfg.MESSAGE_MAX_LENGTH} characters`);
  const { match, otherId } = await getActiveMatch(matchId, user.id);
  await assertCanInteract(user, otherId);
  if (user.status === 'restricted') throw new HttpError(403, 'Your account is under review.', { code: 'account_restricted' });
  rateLimitSend(user.id);

  const mod = moderateText(text);
  if (mod.action === 'block') {
    if (mod.reasons.includes('minor_claim')) {
      await recordSignal(user.id, 'underage_claim', { matchId });
      await query(`INSERT INTO reports (reporter_id, reported_id, reason, details, match_id, status, source, context, priority)
                   VALUES (NULL,$1,'underage_suspected','Automatic: message suggested the sender may be under 18',$2,'open','system','chat',1)`, [user.id, matchId]);
    }
    throw new HttpError(422, 'This message can\'t be sent because it breaks our community guidelines.', { code: 'message_blocked', reasons: mod.reasons });
  }
  const flagged = mod.action === 'flag';
  const row = await one(
    `INSERT INTO messages (match_id, sender_id, text, type, moderation_flag, moderation_reasons, client_id, delivered_at)
     VALUES ($1,$2,$3,'text',$4,$5,$6,$7) RETURNING *`,
    [matchId, user.id, text, flagged ? 'flagged' : null, flagged ? mod.reasons : null, clientId ? String(clientId).slice(0, 64) : null, isOnline(otherId) ? new Date() : null]);

  if (flagged) await scamSignals(user, match, mod, text);

  const sendersView = serializeMessage(row, user.id, await receiptsVisible(user.id, otherId));
  emitToUser(otherId, 'message:new', serializeMessage(row, otherId, false));
  emitToUser(user.id, 'message:sync', sendersView);   // other tabs of the sender
  if (!isOnline(otherId)) {
    const dup = await one(`SELECT 1 FROM notifications WHERE user_id=$1 AND type='message' AND read_at IS NULL AND (data->>'matchId')=$2 LIMIT 1`, [otherId, String(matchId)]);
    if (!dup) notify(otherId, { type: 'message', title: `New message from ${user.name}`, body: 'Open Matchify to read it.', data: { matchId } }).catch(() => {});
  }
  return { message: sendersView, supportHint: mod.support ? SUPPORT_TEXT : undefined, warned: flagged };
}

async function scamSignals(user, match, mod, text) {
  const r = mod.reasons;
  if (r.includes('money_request')) await recordSignal(user.id, 'money_request', { matchId: match.id });
  if (r.includes('crypto_invest')) await recordSignal(user.id, 'crypto_invest', { matchId: match.id });
  if (r.includes('sensitive_credentials')) await recordSignal(user.id, 'sensitive_credentials', { matchId: match.id });
  if (r.includes('offplatform')) {
    const n = await one(`SELECT COUNT(*) c FROM messages WHERE match_id=$1 AND sender_id=$2`, [match.id, user.id]);
    if (Number(n.c) <= 5) await recordSignal(user.id, 'offplatform_early', { matchId: match.id });
  }
  const rep = await one(`SELECT COUNT(DISTINCT match_id) c FROM messages WHERE sender_id=$1 AND LOWER(text)=LOWER($2) AND created_at > NOW() - INTERVAL '60 minutes'`, [user.id, text]);
  if (Number(rep.c) >= 5) await recordSignal(user.id, 'repeated_message', { distinct_matches: Number(rep.c) });
}

async function repeatedMessageCheck(user, text) { /* covered in scamSignals for flagged text; generic spam below */
  const rep = await one(`SELECT COUNT(DISTINCT match_id) c FROM messages WHERE sender_id=$1 AND LOWER(text)=LOWER($2) AND created_at > NOW() - INTERVAL '60 minutes'`, [user.id, text]);
  if (Number(rep.c) >= 5) await recordSignal(user.id, 'repeated_message', { distinct_matches: Number(rep.c) });
}

async function markRead(user, matchId) {
  const { otherId } = await getActiveMatch(matchId, user.id);
  const rows = await many(`UPDATE messages SET read=true, read_at=COALESCE(read_at, NOW()), delivered_at=COALESCE(delivered_at, NOW())
                            WHERE match_id=$1 AND sender_id=$2 AND read_at IS NULL RETURNING id`, [matchId, otherId]);
  if (rows.length && await receiptsVisible(user.id, otherId)) {
    emitToUser(otherId, 'message:read', { matchId: Number(matchId), ids: rows.map((r) => r.id), readerId: user.id });
  }
  return rows.length;
}

async function history(user, matchId, { before, limit = 100 } = {}) {
  const { otherId } = await getActiveMatch(matchId, user.id);
  const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 200);
  const params = [matchId, lim]; let cond = '';
  if (before) { params.push(Number(before)); cond = 'AND id < $3'; }
  const rows = (await many(`SELECT * FROM messages WHERE match_id=$1 ${cond} ORDER BY id DESC LIMIT $2`, params)).reverse();
  const vis = await receiptsVisible(user.id, otherId);
  return { messages: rows.map((m) => serializeMessage(m, user.id, vis)), otherId };
}

module.exports = { getActiveMatch, assertCanInteract, sendMessage, markRead, history, serializeMessage, receiptsVisible };
