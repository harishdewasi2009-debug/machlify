// Random Talk — opt-in, mutual, ephemeral.
//  * A user is only ever paired while ACTIVELY in the queue (joined via socket, online now).
//  * Sessions are NOT matches. They become a match only if BOTH tap "keep".
//  * Text first; voice/video only after BOTH enable it inside the session.
//  * Demo profiles can never be in the queue (they cannot log in, and are rejected here too).
const { one, many, query } = require('../db');
const cfg = require('../config');
const { HttpError, parseJson, userAge } = require('../lib/util');
const { checkVerified } = require('../middleware/auth');
const { moderateText, warningFor, SUPPORT_TEXT } = require('../lib/moderation');
const { emitToUser } = require('../lib/realtime');
const { notify } = require('../lib/notify');
const { recordSignal } = require('../lib/risk');
const { pairAllowed } = require('../lib/visibility');

const queue = new Map();            // userId -> entry
const userSession = new Map();      // userId -> sessionId
const sessions = new Map();         // sessionId -> { id, a, b }
const msgLog = new Map();           // userId -> timestamps (rate limit)
let sweeper = null;

const other = (s, uid) => (s.a === uid ? s.b : s.a);
const attrs = (u) => ({
  id: u.id, name: String(u.name).split(' ')[0], age: userAge(u), gender: u.gender, country: (u.country || '').toLowerCase(),
  tags: u.interest_tags || [], lang: u.language || 'en', verified: !!u.photo_verified,
});
const publicPartner = (a) => ({ name: a.name, age: a.age, country: a.country ? a.country.replace(/\b\w/g, (c) => c.toUpperCase()) : '', interests: a.tags.slice(0, 6), verified: a.verified });

function accepts(filters, o) {
  if (filters.country && o.country !== String(filters.country).toLowerCase()) return false;
  if (filters.gender === 'women' && o.gender !== 'woman') return false;
  if (filters.gender === 'men' && o.gender !== 'man') return false;
  if (filters.interest && !o.tags.includes(String(filters.interest).toLowerCase())) return false;
  if (filters.language && o.lang !== filters.language) return false;
  if (filters.verifiedOnly && !o.verified) return false;
  return true;
}

async function join(user, filters = {}) {
  checkVerified(user);
  if (user.is_demo) throw new HttpError(403, 'Demo profiles cannot use Random Talk.', { code: 'forbidden' });
  if (!user.random_rules_accepted_at) throw new HttpError(403, 'Please accept the Random Talk rules first.', { code: 'rules_required' });
  if (userSession.has(user.id)) throw new HttpError(409, 'You are already in a conversation.', { code: 'in_session' });
  const skips = await one(`SELECT COUNT(*)::int c FROM random_skips WHERE user_id=$1 AND created_at > NOW() - INTERVAL '1 hour'`, [user.id]);
  if (skips.c >= cfg.RANDOM_SKIPS_PER_HOUR) throw new HttpError(429, 'You have skipped a lot of people recently. Take a short break and try again.', { code: 'skip_limit' });
  const clean = {
    country: filters.country ? String(filters.country).slice(0, 60) : '',
    gender: ['women', 'men'].includes(filters.gender) ? filters.gender : 'everyone',
    interest: filters.interest ? String(filters.interest).slice(0, 30) : '',
    language: filters.language ? String(filters.language).slice(0, 8) : '',
    verifiedOnly: !!filters.verifiedOnly,
  };
  queue.set(user.id, { userId: user.id, joinedAt: Date.now(), filters: clean, a: attrs(user) });
  const paired = await tryPair(user.id);
  return { waiting: !paired, queueSize: queue.size };
}

function leave(userId) { return queue.delete(userId); }

async function recentlySkipped(a, b) {
  const r = await one(`SELECT 1 FROM random_skips WHERE ((user_id=$1 AND other_id=$2) OR (user_id=$2 AND other_id=$1))
                         AND created_at > NOW() - ($3 || ' minutes')::interval LIMIT 1`, [a, b, String(cfg.RANDOM_SKIP_MEMORY_MINUTES)]);
  return !!r;
}

async function tryPair(userId) {
  const me = queue.get(userId); if (!me) return null;
  const candidates = [...queue.values()].filter((e) => e.userId !== userId).sort((x, y) => x.joinedAt - y.joinedAt);
  for (const c of candidates) {
    if (!accepts(me.filters, c.a) || !accepts(c.filters, me.a)) continue;
    if (!(await pairAllowed({ one }, userId, c.userId))) continue;
    if (await recentlySkipped(userId, c.userId)) continue;
    // re-check both are still waiting (async gaps)
    if (!queue.has(userId) || !queue.has(c.userId)) continue;
    queue.delete(userId); queue.delete(c.userId);
    const row = await one(`INSERT INTO random_sessions (user_a, user_b) VALUES ($1,$2) RETURNING id`, [userId, c.userId]);
    const s = { id: row.id, a: userId, b: c.userId };
    sessions.set(s.id, s); userSession.set(userId, s.id); userSession.set(c.userId, s.id);
    emitToUser(userId, 'random:paired', { sessionId: s.id, partner: publicPartner(c.a), rules: 'Be kind. No sexual content, no money requests, no personal contact details.' });
    emitToUser(c.userId, 'random:paired', { sessionId: s.id, partner: publicPartner(me.a), rules: 'Be kind. No sexual content, no money requests, no personal contact details.' });
    return s;
  }
  return null;
}

function getSession(userId, sessionId) {
  const s = sessions.get(Number(sessionId));
  if (!s || (s.a !== userId && s.b !== userId) || userSession.get(userId) !== s.id) throw new HttpError(404, 'Session not found or already ended', { code: 'session_not_found' });
  return s;
}

async function sendMessage(user, sessionId, rawText) {
  checkVerified(user);
  const s = getSession(user.id, sessionId);
  const text = String(rawText ?? '').trim();
  if (!text) throw new HttpError(400, 'Message cannot be empty');
  if (text.length > 500) throw new HttpError(400, 'Random Talk messages are limited to 500 characters');
  const now = Date.now();
  const arr = (msgLog.get(user.id) || []).filter((t) => now - t < 60000);
  if (arr.length >= cfg.MESSAGES_PER_MINUTE) throw new HttpError(429, 'Slow down a little.', { code: 'rate_limited' });
  arr.push(now); msgLog.set(user.id, arr);

  const mod = moderateText(text);
  if (mod.action === 'block') throw new HttpError(422, 'This message breaks our community guidelines and was not sent.', { code: 'message_blocked', reasons: mod.reasons });
  const flagged = mod.action === 'flag';
  const row = await one(`INSERT INTO random_messages (session_id, sender_id, text, moderation_flag) VALUES ($1,$2,$3,$4) RETURNING id, created_at`, [s.id, user.id, text, flagged ? 'flagged' : null]);
  const payload = { id: row.id, sessionId: s.id, text, createdAt: row.created_at };
  emitToUser(other(s, user.id), 'random:message', { ...payload, senderId: user.id, warning: flagged ? warningFor(mod.reasons) : undefined });
  if (flagged && mod.highRisk) recordSignal(user.id, mod.reasons.includes('money_request') ? 'money_request' : 'offplatform_early', { sessionId: s.id }).catch(() => {});
  return { message: payload, supportHint: mod.support ? SUPPORT_TEXT : undefined };
}

function typing(user, sessionId, on) {
  const s = getSession(user.id, sessionId);
  emitToUser(other(s, user.id), 'random:typing', { sessionId: s.id, typing: !!on });
}

async function finish(s, status, byUserId, reasonForPartner) {
  sessions.delete(s.id); userSession.delete(s.a); userSession.delete(s.b);
  await query(`UPDATE random_sessions SET status=CASE WHEN status='active' THEN $2 ELSE status END, ended_by=$3, ended_at=NOW() WHERE id=$1`, [s.id, status, byUserId || null]);
  if (byUserId) emitToUser(other(s, byUserId), 'random:ended', { sessionId: s.id, reason: reasonForPartner });
}

async function skip(user, sessionId) {
  const s = getSession(user.id, sessionId);
  const partnerId = other(s, user.id);
  await query('INSERT INTO random_skips (user_id, other_id) VALUES ($1,$2)', [user.id, partnerId]);
  await finish(s, 'skipped', user.id, 'partner_skipped');
  return { ok: true };
}

async function keep(user, sessionId) {
  const s = getSession(user.id, sessionId);
  const col = s.a === user.id ? 'a_keep' : 'b_keep';
  const row = await one(`UPDATE random_sessions SET ${col}=true WHERE id=$1 RETURNING *`, [s.id]);
  if (!(row.a_keep && row.b_keep)) {
    emitToUser(other(s, user.id), 'random:keep_status', { sessionId: s.id, partnerWantsToKeep: true });
    return { waitingForPartner: true };
  }
  const [x, y] = row.user_a < row.user_b ? [row.user_a, row.user_b] : [row.user_b, row.user_a];
  const m = await one(`INSERT INTO matches (user_a, user_b, source) VALUES ($1,$2,'random_talk')
                       ON CONFLICT (user_a, user_b) DO UPDATE SET status='active', closed_by=NULL, closed_reason=NULL, closed_at=NULL RETURNING *`, [x, y]);
  await query(`UPDATE random_sessions SET status='kept', match_id=$2, ended_at=NOW() WHERE id=$1`, [s.id, m.id]);
  sessions.delete(s.id); userSession.delete(s.a); userSession.delete(s.b);
  emitToUser(s.a, 'random:matched', { sessionId: s.id, matchId: m.id });
  emitToUser(s.b, 'random:matched', { sessionId: s.id, matchId: m.id });
  for (const uid of [s.a, s.b]) notify(uid, { type: 'match', title: 'You both chose to keep chatting 💬', body: 'Your Random Talk is now a match.', data: { matchId: m.id } }).catch(() => {});
  return { matched: true, matchId: m.id };
}

async function enable(user, sessionId, kind) {
  if (!['voice', 'video'].includes(kind)) throw new HttpError(400, 'kind must be voice or video');
  const s = getSession(user.id, sessionId);
  const col = `${s.a === user.id ? 'a' : 'b'}_${kind}`;
  const row = await one(`UPDATE random_sessions SET ${col}=true WHERE id=$1 RETURNING *`, [s.id]);
  const both = row[`a_${kind}`] && row[`b_${kind}`];
  if (both) { emitToUser(s.a, 'random:media_enabled', { sessionId: s.id, kind }); emitToUser(s.b, 'random:media_enabled', { sessionId: s.id, kind }); }
  else emitToUser(other(s, user.id), 'random:media_requested', { sessionId: s.id, kind });
  return { enabled: !!both };
}

// WebRTC signalling relay — only after BOTH sides enabled the media kind.
async function signal(user, sessionId, data) {
  const s = getSession(user.id, sessionId);
  const row = await one('SELECT a_voice,b_voice,a_video,b_video FROM random_sessions WHERE id=$1', [s.id]);
  if (!((row.a_voice && row.b_voice) || (row.a_video && row.b_video))) throw new HttpError(403, 'Both people must enable voice/video first.', { code: 'media_not_enabled' });
  emitToUser(other(s, user.id), 'random:signal', { sessionId: s.id, data });
}

async function disconnect(userId) {
  queue.delete(userId);
  const sid = userSession.get(userId);
  if (sid && sessions.has(sid)) await finish(sessions.get(sid), 'ended', userId, 'partner_left');
}

async function endSessionsBetween(a, b, reason) {
  for (const s of [...sessions.values()]) {
    if ((s.a === a && s.b === b) || (s.a === b && s.b === a)) await finish(s, reason === 'reported' ? 'reported' : 'ended', a, reason === 'reported' ? 'partner_left' : 'partner_left');
  }
}

async function sweepQueue() {
  const now = Date.now();
  for (const e of [...queue.values()]) {
    if (now - e.joinedAt > cfg.RANDOM_QUEUE_TIMEOUT_MS) { queue.delete(e.userId); emitToUser(e.userId, 'random:timeout', {}); }
    else if (!sessions.size || true) await tryPair(e.userId).catch(() => {});
  }
}

async function init() {
  await query(`UPDATE random_sessions SET status='ended', ended_at=NOW() WHERE status='active'`);
  if (!sweeper) { sweeper = setInterval(() => sweepQueue().catch(() => {}), 10000); sweeper.unref(); }
}
function reset() { queue.clear(); userSession.clear(); sessions.clear(); msgLog.clear(); }
const isQueued = (id) => queue.has(id);
const inSession = (id) => userSession.has(id);
const state = () => ({ queue: queue.size, sessions: sessions.size });

module.exports = { join, leave, sendMessage, typing, skip, keep, enable, signal, disconnect, endSessionsBetween, init, reset, isQueued, inSession, state, sweepQueue, tryPair };
