// Thin wrapper over the socket module so services never import socket.io
// types directly, and so tests can run with no socket server (no-ops).
import { emitToUser, getIO } from "../../websocket/socket";

export const roomForSession = (sessionId: string) => `rc:${sessionId}`;

export function toUser(userId: string, event: string, payload: unknown) {
  emitToUser(userId, event, payload);
}

export function toSession(sessionId: string, event: string, payload: unknown) {
  getIO()?.to(roomForSession(sessionId)).emit(event, payload);
}

export function joinSessionRoom(userIds: string[], sessionId: string) {
  const io = getIO();
  if (!io) return;
  for (const id of userIds) io.in(`user:${id}`).socketsJoin(roomForSession(sessionId));
}

export function leaveSessionRoom(sessionId: string) {
  getIO()?.in(roomForSession(sessionId)).socketsLeave(roomForSession(sessionId));
}
