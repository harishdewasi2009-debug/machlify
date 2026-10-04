import type { Server as HttpServer } from "node:http";
import * as cookie from "cookie";
import { Server as SocketIOServer, Socket } from "socket.io";
import { env, allowedOrigins } from "../config/env";
import { prisma } from "../config/prisma";
import { verifyAccessToken } from "../utils/tokens";
import * as chatService from "../services/chat.service";
import * as callService from "../services/call.service";
import { registerRandomChatHandlers, onRandomChatConnect, onRandomChatDisconnect } from "./randomChat.socket";

interface AuthedSocket extends Socket {
  userId?: string;
}

// In-memory presence: userId -> set of connected socket ids. This is fine for
// a single backend instance. At real scale, running multiple instances, this
// needs to move to the Socket.io Redis adapter (for cross-instance room
// broadcast) plus a shared presence set — a single process's Map can't see
// sockets connected to a different instance.
const onlineSockets = new Map<string, Set<string>>();

// Tracks which two users a still-live call is between, so WebRTC signaling
// events (offer/answer/ICE candidates, which arrive far more often than call
// state changes) can be authorized with a cheap in-memory check instead of a
// DB round trip per candidate. This is a cache over the Call row, not a
// second source of truth — if the process restarts mid-call the map is
// empty and signaling for that call correctly stops working (the call
// itself should be re-negotiated, not silently trusted from thin air).
const activeCallParticipants = new Map<string, { callerId: string; calleeId: string }>();

// Server-side ring timeout per call: if nobody accepts within
// CALL_RING_TIMEOUT_SECONDS, the call is marked MISSED here rather than
// waiting on either client to give up and say so themselves (a caller who
// simply closes the tab should not leave the callee's phone ringing forever).
const ringTimers = new Map<string, NodeJS.Timeout>();

let io: SocketIOServer | null = null;

function roomForConversation(conversationId: string): string {
  return `conversation:${conversationId}`;
}

function roomForUser(userId: string): string {
  return `user:${userId}`;
}

async function readAccessTokenFromHandshake(socket: Socket): Promise<string | null> {
  const raw = socket.handshake.headers.cookie;
  if (!raw) return null;
  const parsed = cookie.parse(raw);
  return parsed.accessToken ?? null;
}

// Same trust boundary as requireAuth for REST: verify the JWT signature,
// then confirm the session it references is still live and unrevoked, then
// confirm the user is still active. A valid-looking JWT alone is not enough
// (e.g. after logout-all-devices, its session row is revoked).
async function authenticateSocket(socket: AuthedSocket): Promise<string> {
  const token = await readAccessTokenFromHandshake(socket);
  if (!token) throw new Error("UNAUTHORIZED");

  const payload = verifyAccessToken(token);
  const session = await prisma.session.findUnique({ where: { id: payload.sessionId } });
  if (!session || session.revoked || session.expiresAt < new Date()) {
    throw new Error("UNAUTHORIZED");
  }

  const user = await prisma.user.findUnique({ where: { id: payload.sub } });
  if (!user || user.status !== "ACTIVE") throw new Error("UNAUTHORIZED");

  return user.id;
}

async function joinOwnConversationRooms(socket: Socket, userId: string) {
  const memberships = await prisma.conversationMember.findMany({
    where: { userId },
    select: { conversationId: true },
  });
  for (const m of memberships) {
    socket.join(roomForConversation(m.conversationId));
  }
  socket.join(roomForUser(userId));
}

function markOnline(userId: string, socketId: string) {
  const set = onlineSockets.get(userId) ?? new Set<string>();
  const wasOffline = set.size === 0;
  set.add(socketId);
  onlineSockets.set(userId, set);
  return wasOffline;
}

function markOffline(userId: string, socketId: string) {
  const set = onlineSockets.get(userId);
  if (!set) return false;
  set.delete(socketId);
  const isNowOffline = set.size === 0;
  if (isNowOffline) onlineSockets.delete(userId);
  return isNowOffline;
}

// Acks let the client know whether an emitted action actually succeeded —
// without this, a rejected message (e.g. sent to a conversation the user
// isn't a member of, or to someone who blocked them) would silently vanish
// on the client with no error shown.
export async function withAck<T>(ack: ((response: { success: boolean; data?: T; error?: string }) => void) | undefined, fn: () => Promise<T>) {
  try {
    const data = await fn();
    ack?.({ success: true, data });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Something went wrong.";
    ack?.({ success: false, error: message });
  }
}

function clearRingTimer(callId: string) {
  const timer = ringTimers.get(callId);
  if (timer) {
    clearTimeout(timer);
    ringTimers.delete(callId);
  }
}

function scheduleRingTimeout(callId: string, callerId: string, calleeId: string) {
  const timer = setTimeout(async () => {
    ringTimers.delete(callId);
    const becameMissed = await callService.markMissedIfStillRinging(callId);
    if (becameMissed) {
      activeCallParticipants.delete(callId);
      io?.to(roomForUser(callerId)).emit("call:missed", { callId });
      io?.to(roomForUser(calleeId)).emit("call:missed", { callId });
    }
  }, env.CALL_RING_TIMEOUT_SECONDS * 1000);
  ringTimers.set(callId, timer);
}

// Authorizes a signaling message against the call it claims to belong to.
// Checks the in-memory cache first; falls back to the database (and repopulates
// the cache) so signaling still works after a server restart mid-call, but a
// caller can never relay an offer/candidate into a call they aren't part of.
async function participantsForCall(userId: string, callId: string) {
  const cached = activeCallParticipants.get(callId);
  if (cached) {
    if (cached.callerId !== userId && cached.calleeId !== userId) throw new Error("FORBIDDEN");
    return cached;
  }
  const call = await callService.getCall(userId, callId); // throws if not a participant or not found
  const participants = { callerId: call.callerId, calleeId: call.calleeId };
  activeCallParticipants.set(callId, participants);
  return participants;
}

function otherParticipant(participants: { callerId: string; calleeId: string }, userId: string) {
  return participants.callerId === userId ? participants.calleeId : participants.callerId;
}

async function endActiveCallOnDisconnect(userId: string) {
  const call = await callService.findActiveCallForUser(userId);
  if (!call) return;

  clearRingTimer(call.id);
  activeCallParticipants.delete(call.id);

  if (call.status === "RINGING") {
    await callService.markMissedIfStillRinging(call.id);
  } else {
    await callService.markFailed(call.id);
  }

  const other = call.callerId === userId ? call.calleeId : call.callerId;
  io?.to(roomForUser(other)).emit("call:end", { callId: call.id, reason: "peer_disconnected" });
}

export function initSocket(httpServer: HttpServer): SocketIOServer {
  io = new SocketIOServer(httpServer, {
    cors: { origin: allowedOrigins, credentials: true },
  });

  io.use(async (socket: AuthedSocket, next) => {
    try {
      socket.userId = await authenticateSocket(socket);
      next();
    } catch {
      next(new Error("UNAUTHORIZED"));
    }
  });

  io.on("connection", (socket: AuthedSocket) => {
    const userId = socket.userId;
    if (!userId) {
      socket.disconnect(true);
      return;
    }

    void joinOwnConversationRooms(socket, userId);
    const cameOnline = markOnline(userId, socket.id);
    if (cameOnline) {
      socket.broadcast.emit("presence:online", { userId });
    }
    void onRandomChatConnect(socket, userId, cameOnline);
    registerRandomChatHandlers(socket, userId, withAck);

    socket.on("message:send", (payload, ack) =>
      withAck(ack, async () => {
        const message = await chatService.sendMessage(
          userId,
          payload?.conversationId,
          payload?.content,
          payload?.type
        );
        io!.to(roomForConversation(message.conversationId)).emit("message:new", message);
        return message;
      })
    );

    socket.on("message:read", (payload, ack) =>
      withAck(ack, async () => {
        if (!payload?.conversationId) throw new Error("conversationId is required.");
        await chatService.markConversationRead(userId, payload.conversationId);
        io!
          .to(roomForConversation(payload.conversationId))
          .emit("message:read", { conversationId: payload.conversationId, readByUserId: userId });
        return { ok: true };
      })
    );

    socket.on("typing:start", (payload) => {
      if (!payload?.conversationId) return;
      socket.to(roomForConversation(payload.conversationId)).emit("typing:start", {
        conversationId: payload.conversationId,
        userId,
      });
    });

    socket.on("typing:stop", (payload) => {
      if (!payload?.conversationId) return;
      socket.to(roomForConversation(payload.conversationId)).emit("typing:stop", {
        conversationId: payload.conversationId,
        userId,
      });
    });

    // --- Voice/video call signaling ---
    // Call state changes (invite/accept/reject/end) go through call.service
    // so REST and socket paths can't diverge, exactly like message:send does
    // for chat.service. WebRTC's own offer/answer/ICE-candidate payloads are
    // opaque to the backend — they're relayed to the other participant only,
    // never broadcast, and only after confirming both users are actually the
    // two participants of that call.

    socket.on("call:invite", (payload, ack) =>
      withAck(ack, async () => {
        const type = payload?.type === "VIDEO" ? "VIDEO" : "VOICE";
        const call = await callService.initiateCall(userId, payload?.calleeId, type);

        if (call.status === "BUSY") {
          return { callId: call.id, status: "BUSY" as const };
        }

        activeCallParticipants.set(call.id, { callerId: call.callerId, calleeId: call.calleeId });
        io!.to(roomForUser(call.calleeId)).emit("call:invite", {
          callId: call.id,
          callerId: userId,
          type,
        });
        scheduleRingTimeout(call.id, call.callerId, call.calleeId);
        return { callId: call.id, status: call.status };
      })
    );

    socket.on("call:accept", (payload, ack) =>
      withAck(ack, async () => {
        if (!payload?.callId) throw new Error("callId is required.");
        const call = await callService.acceptCall(userId, payload.callId);
        clearRingTimer(call.id);
        io!.to(roomForUser(call.callerId)).emit("call:accept", { callId: call.id });
        return call;
      })
    );

    socket.on("call:reject", (payload, ack) =>
      withAck(ack, async () => {
        if (!payload?.callId) throw new Error("callId is required.");
        const call = await callService.rejectCall(userId, payload.callId);
        clearRingTimer(call.id);
        activeCallParticipants.delete(call.id);
        io!.to(roomForUser(call.callerId)).emit("call:reject", { callId: call.id });
        return call;
      })
    );

    socket.on("call:end", (payload, ack) =>
      withAck(ack, async () => {
        if (!payload?.callId) throw new Error("callId is required.");
        const call = await callService.endCall(userId, payload.callId);
        clearRingTimer(call.id);
        const participants = activeCallParticipants.get(call.id);
        activeCallParticipants.delete(call.id);
        const other = participants ? otherParticipant(participants, userId) : null;
        if (other) io!.to(roomForUser(other)).emit("call:end", { callId: call.id, reason: "hangup" });
        return call;
      })
    );

    socket.on("webrtc:offer", (payload) => {
      if (!payload?.callId || !payload?.offer) return;
      participantsForCall(userId, payload.callId)
        .then((participants) => {
          io!.to(roomForUser(otherParticipant(participants, userId))).emit("webrtc:offer", {
            callId: payload.callId,
            offer: payload.offer,
            fromUserId: userId,
          });
        })
        .catch(() => {
          // Not a participant of this call, or it no longer exists — drop
          // silently rather than let a stray/forged callId probe call state.
        });
    });

    socket.on("webrtc:answer", (payload) => {
      if (!payload?.callId || !payload?.answer) return;
      participantsForCall(userId, payload.callId)
        .then((participants) => {
          io!.to(roomForUser(otherParticipant(participants, userId))).emit("webrtc:answer", {
            callId: payload.callId,
            answer: payload.answer,
            fromUserId: userId,
          });
        })
        .catch(() => {});
    });

    socket.on("webrtc:ice-candidate", (payload) => {
      if (!payload?.callId || !payload?.candidate) return;
      participantsForCall(userId, payload.callId)
        .then((participants) => {
          io!.to(roomForUser(otherParticipant(participants, userId))).emit("webrtc:ice-candidate", {
            callId: payload.callId,
            candidate: payload.candidate,
            fromUserId: userId,
          });
        })
        .catch(() => {});
    });

    socket.on("disconnect", () => {
      const wentOffline = markOffline(userId, socket.id);
      if (wentOffline) {
        socket.broadcast.emit("presence:offline", { userId });
        void endActiveCallOnDisconnect(userId);
        void onRandomChatDisconnect(userId);
      }
    });
  });

  return io;
}

export function getIO(): SocketIOServer | null {
  return io;
}

export function isUserOnline(userId: string): boolean {
  return (onlineSockets.get(userId)?.size ?? 0) > 0;
}

// Safe to call even if a conversation has no connected members, or if
// initSocket hasn't run yet (e.g. under test) — it's a no-op rather than a
// throw, since real-time delivery is a convenience on top of the persisted
// row, never the only record of a message/notification.
export function emitToConversation(conversationId: string, event: string, payload: unknown) {
  io?.to(roomForConversation(conversationId)).emit(event, payload);
}

export function emitToUser(userId: string, event: string, payload: unknown) {
  io?.to(roomForUser(userId)).emit(event, payload);
}

// A conversation created *after* a user's socket connected (i.e. a brand-new
// match) isn't in the rooms joinOwnConversationRooms() joined at connect
// time, so without this its live messages would only arrive after a
// reconnect. Safe no-op when no sockets are connected or io isn't running.
export function joinUsersToConversation(userIds: string[], conversationId: string) {
  if (!io) return;
  for (const userId of userIds) {
    io.in(roomForUser(userId)).socketsJoin(roomForConversation(conversationId));
  }
}
