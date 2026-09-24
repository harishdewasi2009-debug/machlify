// Holds the Socket.io server + in-memory presence so any module can push events.
const state = { io: null, online: new Map() }; // userId -> Set(socketId)

function setIo(io) { state.io = io; }
function addSocket(userId, id) {
  if (!state.online.has(userId)) state.online.set(userId, new Set());
  state.online.get(userId).add(id);
}
function removeSocket(userId, id) {
  const s = state.online.get(userId); if (!s) return false;
  s.delete(id); if (!s.size) { state.online.delete(userId); return true; }
  return false;
}
const isOnline = (userId) => state.online.has(Number(userId));
function socketsFor(userId) {
  if (!state.io) return [];
  const s = state.online.get(Number(userId)); if (!s) return [];
  return [...s].map((id) => state.io.sockets.sockets.get(id)).filter(Boolean);
}
function emitToUser(userId, event, payload) {
  socketsFor(userId).forEach((s) => s.emit(event, payload));
}
function disconnectUser(userId, reason) {
  socketsFor(userId).forEach((s) => { s.emit('force:logout', { reason }); s.disconnect(true); });
}
module.exports = { setIo, addSocket, removeSocket, isOnline, socketsFor, emitToUser, disconnectUser, state };
