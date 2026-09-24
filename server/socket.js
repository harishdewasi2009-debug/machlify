// Socket.io: realtime chat (send/read/typing), call signalling, Random Talk.
// Every social event re-loads the user, re-checks the 18+ gate, blocks and match
// membership — an open socket is never a bypass.
const { Server } = require('socket.io');
const { one, query } = require('./db');
const cfg = require('./config');
const realtime = require('./lib/realtime');
const { authenticateToken } = require('./middleware/auth');
const { HttpError } = require('./lib/util');
const chat = require('./services/chat');
const random = require('./services/randomTalk');
const { notify } = require('./lib/notify');
const logger = require('./lib/logger');

const callState = new Map();     // userId -> { peer, matchId, state: 'ringing'|'active', timer }
const inviteLog = new Map();
const typingLog = new Map();

function clearCall(userId, notifyPeer = false) {
  const c = callState.get(userId);
  if (!c) return;
  clearTimeout(c.timer);
  callState.delete(userId);
  const peer = callState.get(c.peer);
  if (peer && peer.peer === userId) { clearTimeout(peer.timer); callState.delete(c.peer); }
  if (notifyPeer) realtime.emitToUser(c.peer, 'call:ended', { fromUserId: userId });
}

function attachSocket(httpServer) {
  const origin = process.env.APP_ORIGIN || false;
  const io = new Server(httpServer, { cors: { origin, credentials: true }, maxHttpBufferSize: 1e5 });
  realtime.setIo(io);
  random.init().catch((e) => logger.error({ err: e.message }, 'random init failed'));

  io.use(async (socket, next) => {
    try {
      const user = await authenticateToken(socket.handshake.auth?.token);
      if (['banned', 'deleted', 'suspended', 'pending_deletion'].includes(user.status)) return next(new Error('account_' + user.status));
      socket.data.userId = user.id; socket.data.tv = user.token_version;
      next();
    } catch (e) { next(new Error(e.extra?.code || 'auth_failed')); }
  });

  io.on('connection', async (socket) => {
    const uid = socket.data.userId;
    const first = !realtime.isOnline(uid);
    realtime.addSocket(uid, socket.id);
    if (first) query('UPDATE users SET is_online=true, last_active_at=NOW() WHERE id=$1', [uid]).catch(() => {});

    // Wrap a handler with fresh-user loading + error → ack translation.
    const on = (event, fn, { social = true } = {}) => socket.on(event, async (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      try {
        const user = await one('SELECT * FROM users WHERE id=$1', [uid]);
        if (!user || user.token_version !== socket.data.tv || ['banned', 'deleted', 'suspended', 'pending_deletion'].includes(user.status)) {
          socket.emit('force:logout', { reason: 'session_invalid' });
          reply({ ok: false, error: 'Session expired', code: 'session_invalid', status: 401 });
          socket.disconnect(true); return;
        }
        if (social) require('./middleware/auth').checkVerified(user);
        const out = await fn(user, payload || {});
        reply({ ok: true, ...(out || {}) });
      } catch (e) {
        if (!(e instanceof HttpError)) logger.error({ err: e.message, event }, 'socket handler error');
        reply({ ok: false, error: e instanceof HttpError ? e.message : 'Something went wrong', code: e.extra?.code, status: e.status });
      }
    });

    // ---------- chat ----------
    on('message:send', (user, p) => chat.sendMessage(user, p.matchId, p.text, { clientId: p.clientId }));
    on('message:read', async (user, p) => ({ marked: await chat.markRead(user, p.matchId) }));
    const typing = (on_) => async (user, p) => {
      const { otherId } = await chat.getActiveMatch(p.matchId, user.id);
      await chat.assertCanInteract(user, otherId);
      const k = `${user.id}:${p.matchId}`; const now = Date.now();
      if (on_ && now - (typingLog.get(k) || 0) < 1500) return;
      typingLog.set(k, on_ ? now : 0);
      realtime.emitToUser(otherId, 'typing', { matchId: Number(p.matchId), typing: on_ });
    };
    on('typing:start', typing(true)); on('typing:stop', typing(false));

    // ---------- calls (matches) ----------
    async function assertPair(user, toUserId, matchId) {
      const { match, otherId } = await chat.getActiveMatch(matchId, user.id);
      if (otherId !== Number(toUserId)) throw new HttpError(403, 'You are not matched with that user.', { code: 'not_matched' });
      await chat.assertCanInteract(user, otherId);
      return { match, otherId };
    }
    on('call:invite', async (user, p) => {
      const { match, otherId } = await assertPair(user, p.toUserId, p.matchId);
      if (!['audio', 'video'].includes(p.callType)) throw new HttpError(400, 'callType must be audio or video');
      if (cfg.CALLS_REQUIRE_MESSAGES()) {
        const r = await one(`SELECT COUNT(DISTINCT sender_id)::int c FROM messages WHERE match_id=$1 AND type='text'`, [match.id]);
        if (r.c < 2) throw new HttpError(403, 'Calls unlock after you have both sent a message.', { code: 'calls_locked' });
      }
      const now = Date.now(); const log = (inviteLog.get(user.id) || []).filter((t) => now - t < 60000);
      if (log.length >= cfg.CALL_INVITES_PER_MINUTE) throw new HttpError(429, 'Too many call attempts.', { code: 'rate_limited' });
      log.push(now); inviteLog.set(user.id, log);
      if (callState.has(user.id)) throw new HttpError(409, 'You are already on a call.', { code: 'busy' });
      if (callState.has(otherId) || !realtime.isOnline(otherId)) {
        if (!realtime.isOnline(otherId)) notify(otherId, { type: 'call', title: `Missed call from ${user.name}`, data: { matchId: match.id } }).catch(() => {});
        throw new HttpError(409, realtime.isOnline(otherId) ? 'They are on another call.' : 'They are offline right now.', { code: realtime.isOnline(otherId) ? 'busy' : 'offline' });
      }
      const timer = setTimeout(() => {
        if (callState.get(user.id)?.state === 'ringing') {
          realtime.emitToUser(otherId, 'call:cancelled', { fromUserId: user.id });
          realtime.emitToUser(user.id, 'call:rejected', { fromUserId: otherId, reason: 'no_answer' });
          clearCall(user.id);
        }
      }, 45000); timer.unref();
      callState.set(user.id, { peer: otherId, matchId: match.id, state: 'ringing', timer, caller: true });
      callState.set(otherId, { peer: user.id, matchId: match.id, state: 'ringing', timer: null });
      realtime.emitToUser(otherId, 'call:incoming', { fromUserId: user.id, fromName: user.name, matchId: match.id, callType: p.callType });
    });
    const inCallWith = (uid_, peerId, matchId) => { const c = callState.get(uid_); return c && c.peer === Number(peerId) && String(c.matchId) === String(matchId); };
    on('call:accept', async (user, p) => {
      await assertPair(user, p.toUserId, p.matchId);
      if (!inCallWith(user.id, p.toUserId, p.matchId)) throw new HttpError(409, 'No such call.', { code: 'no_call' });
      callState.get(user.id).state = 'active'; callState.get(Number(p.toUserId)).state = 'active';
      clearTimeout(callState.get(Number(p.toUserId))?.timer);
      realtime.emitToUser(p.toUserId, 'call:accepted', { fromUserId: user.id });
    });
    on('call:reject', async (user, p) => {
      if (!inCallWith(user.id, p.toUserId, p.matchId)) throw new HttpError(409, 'No such call.', { code: 'no_call' });
      realtime.emitToUser(p.toUserId, 'call:rejected', { fromUserId: user.id, reason: p.reason || 'declined' });
      clearCall(user.id);
    }, { social: false });
    on('call:cancel', async (user, p) => {
      if (!inCallWith(user.id, p.toUserId, p.matchId)) return;
      realtime.emitToUser(p.toUserId, 'call:cancelled', { fromUserId: user.id }); clearCall(user.id);
    }, { social: false });
    on('call:end', async (user, p) => {
      if (!inCallWith(user.id, p.toUserId, p.matchId)) return;
      realtime.emitToUser(p.toUserId, 'call:ended', { fromUserId: user.id }); clearCall(user.id);
    }, { social: false });
    on('call:signal', async (user, p) => {
      // Signalling is only relayed inside a live call between two matched, unblocked users.
      await assertPair(user, p.toUserId, p.matchId);
      if (!inCallWith(user.id, p.toUserId, p.matchId)) throw new HttpError(403, 'No active call with that user.', { code: 'no_call' });
      if (!p.data || typeof p.data !== 'object') throw new HttpError(400, 'Invalid signal');
      realtime.emitToUser(p.toUserId, 'call:signal', { fromUserId: user.id, data: p.data });
    });

    // ---------- Random Talk ----------
    on('random:join', async (user, p) => random.join(user, p));
    on('random:leave', async (user) => ({ left: random.leave(user.id) }));
    on('random:message', (user, p) => random.sendMessage(user, p.sessionId, p.text));
    on('random:typing', async (user, p) => { random.typing(user, p.sessionId, p.typing); });
    on('random:skip', (user, p) => random.skip(user, p.sessionId));
    on('random:keep', (user, p) => random.keep(user, p.sessionId));
    on('random:enable', (user, p) => random.enable(user, p.sessionId, p.kind));
    on('random:signal', (user, p) => random.signal(user, p.sessionId, p.data));

    socket.on('disconnect', () => {
      const last = realtime.removeSocket(uid, socket.id);
      if (last) {
        query('UPDATE users SET is_online=false, last_active_at=NOW() WHERE id=$1', [uid]).catch(() => {});
        random.disconnect(uid).catch(() => {});
        clearCall(uid, true);
      }
    });
  });
  return io;
}

module.exports = { attachSocket, attach: attachSocket, callState };
