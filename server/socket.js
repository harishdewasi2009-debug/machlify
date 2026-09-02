const jwt = require('jsonwebtoken');
const { query } = require('./db');

// userId -> Set of socket ids (a user can have multiple tabs/devices)
const onlineUsers = new Map();

function addSocket(userId, socketId) {
  if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
  onlineUsers.get(userId).add(socketId);
}
function removeSocket(userId, socketId) {
  const set = onlineUsers.get(userId);
  if (!set) return;
  set.delete(socketId);
  if (set.size === 0) onlineUsers.delete(userId);
}
function socketsFor(io, userId) {
  const set = onlineUsers.get(userId);
  if (!set) return [];
  return Array.from(set).map(id => io.sockets.sockets.get(id)).filter(Boolean);
}

function initSocket(io) {
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth && socket.handshake.auth.token;
      if (!token) return next(new Error('Missing auth token'));
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      socket.userId = payload.userId;
      next();
    } catch (err) {
      next(new Error('Invalid or expired token'));
    }
  });

  io.on('connection', (socket) => {
    const userId = socket.userId;
    addSocket(userId, socket.id);
    query('UPDATE users SET is_online = true WHERE id = $1', [userId]).catch(() => {});

    // ---- Call signaling ----
    // Caller starts a call
    socket.on('call:invite', ({ toUserId, matchId, callType, fromName }) => {
      socketsFor(io, toUserId).forEach(s => {
        s.emit('call:incoming', { fromUserId: userId, fromName, matchId, callType });
      });
    });

    socket.on('call:accept', ({ toUserId, matchId }) => {
      socketsFor(io, toUserId).forEach(s => s.emit('call:accepted', { fromUserId: userId, matchId }));
    });

    socket.on('call:reject', ({ toUserId, matchId, reason }) => {
      socketsFor(io, toUserId).forEach(s => s.emit('call:rejected', { fromUserId: userId, matchId, reason: reason || 'declined' }));
    });

    socket.on('call:cancel', ({ toUserId, matchId }) => {
      socketsFor(io, toUserId).forEach(s => s.emit('call:cancelled', { fromUserId: userId, matchId }));
    });

    socket.on('call:end', ({ toUserId, matchId }) => {
      socketsFor(io, toUserId).forEach(s => s.emit('call:ended', { fromUserId: userId, matchId }));
    });

    // WebRTC SDP offer/answer + ICE candidate relay
    socket.on('call:signal', ({ toUserId, data }) => {
      socketsFor(io, toUserId).forEach(s => s.emit('call:signal', { fromUserId: userId, data }));
    });

    socket.on('disconnect', () => {
      removeSocket(userId, socket.id);
      if (!onlineUsers.has(userId)) {
        query('UPDATE users SET is_online = false WHERE id = $1', [userId]).catch(() => {});
      }
    });
  });
}

module.exports = { initSocket };
