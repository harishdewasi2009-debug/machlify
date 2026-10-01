import type { Socket } from "socket.io";
import { prisma } from "../config/prisma";
import * as mm from "../services/randomChat/matchmaking.service";
import * as chat from "../services/randomChat/chat.service";
import * as social from "../services/randomChat/social.service";
import { roomForSession, joinSessionRoom, toUser } from "../services/randomChat/events";
import { reportSchema } from "../validators/randomChat.validator";

type Ack = ((r: { success: boolean; data?: unknown; error?: string; code?: string }) => void) | undefined;
type WithAck = <T>(ack: Ack, fn: () => Promise<T>) => Promise<void>;

async function activeSessions(userId: string) {
  return prisma.randomChatSession.findMany({
    where: { status: "ACTIVE", OR: [{ user1Id: userId }, { user2Id: userId }] },
  });
}

async function setPresence(userId: string, online: boolean) {
  await prisma.userPresence.upsert({
    where: { userId },
    update: { online, lastSeenAt: new Date() },
    create: { userId, online, lastSeenAt: new Date() },
  });
}

async function tellPartners(userId: string, online: boolean) {
  for (const s of await activeSessions(userId)) {
    const partner = s.user1Id === userId ? s.user2Id : s.user1Id;
    toUser(partner, "random_chat:presence", { sessionId: s.id, online });
  }
}

// First socket for this user came up (or a reconnect after a drop).
export async function onRandomChatConnect(socket: Socket, userId: string, cameOnline: boolean) {
  try {
    await setPresence(userId, true);
    // Reconnection handling: put the socket straight back into any live
    // session room so messages keep flowing without the client re-joining.
    const sessions = await activeSessions(userId);
    for (const s of sessions) socket.join(roomForSession(s.id));
    if (cameOnline) await tellPartners(userId, true);
  } catch {
    /* presence is best-effort */
  }
}

// Last socket for this user went away. We do NOT end the session here: a
// phone switching from Wi-Fi to 4G drops and reconnects within seconds. The
// cleanup worker ends it if no heartbeat arrives within RC_SESSION_STALE_SECONDS.
export async function onRandomChatDisconnect(userId: string) {
  try {
    await setPresence(userId, false);
    await tellPartners(userId, false);
  } catch {
    /* best-effort */
  }
}

export function registerRandomChatHandlers(socket: Socket, userId: string, withAck: WithAck) {
  const wrap = (event: string, fn: (payload: any) => Promise<unknown>) =>
    socket.on(event, (payload: any, ack: Ack) => withAck(ack as any, () => fn(payload ?? {})));

  wrap("random_chat:join", async (p) => {
    const status = await mm.join(userId, { socketId: socket.id, captchaToken: p.captchaToken, ip: socket.handshake.address });
    if (status.state === "waiting") socket.emit("random_chat:waiting", status);
    if (status.state === "chatting") joinSessionRoom([userId], status.session.id);
    return status;
  });

  wrap("random_chat:leave", async () => mm.leave(userId));

  wrap("random_chat:next", async (p) => {
    const status = await mm.next(userId, { sessionId: p.sessionId, socketId: socket.id, captchaToken: p.captchaToken, ip: socket.handshake.address });
    if (status.state === "waiting") socket.emit("random_chat:waiting", status);
    return status;
  });

  wrap("random_chat:end", async (p) => mm.endByUser(userId, p.sessionId));

  // Used on every (re)connect so the client can recover whatever it was doing.
  wrap("random_chat:resume", async () => {
    const status = await mm.getStatus(userId);
    if (status.state === "chatting") socket.join(roomForSession(status.session.id));
    return status;
  });

  wrap("random_chat:heartbeat", async () => {
    await mm.heartbeat(userId, socket.id);
    return { t: Date.now() };
  });

  wrap("random_chat:message", async (p) => {
    const r = await chat.sendMessage(userId, p.sessionId, p.content, p.clientId);
    if (!r.duplicate) chat.broadcastMessage(r.message, r.recipientId);
    return { id: r.message.id, clientId: r.message.clientId, createdAt: r.message.createdAt, deliveredAt: r.message.deliveredAt, duplicate: r.duplicate };
  });

  // Typing is ephemeral and unauthenticated-by-DB for speed: membership is
  // enforced by the room itself (only participants are ever in it).
  socket.on("random_chat:typing", (p: any) => {
    if (!p?.sessionId || !socket.rooms.has(roomForSession(p.sessionId))) return;
    socket.to(roomForSession(p.sessionId)).emit("random_chat:typing", { sessionId: p.sessionId, typing: Boolean(p.typing) });
  });

  wrap("random_chat:read", async (p) => {
    const r = await chat.markRead(userId, p.sessionId);
    if (r.count > 0) toUser(r.partnerId, "random_chat:read", { sessionId: p.sessionId, readAt: r.readAt });
    return { count: r.count };
  });

  wrap("random_chat:block", async (p) => social.blockPartner(userId, p.sessionId));
  wrap("random_chat:report", async (p) => {
    const { reason, description } = reportSchema.parse({ reason: p.reason, description: p.description });
    return social.reportPartner(userId, p.sessionId, reason, description);
  });
}
