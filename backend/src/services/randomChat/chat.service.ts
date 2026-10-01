import { prisma } from "../../config/prisma";
import { env } from "../../config/env";
import { Errors } from "../../utils/apiError";
import { checkMessageContent, normalizeForDuplicateCheck } from "../../utils/randomChatFilter";
import { assertNotBanned, messageLimiter, noteFilteredMessage, noteSpamMessage, rateLimited } from "./safety";
import { toMessageDto, userIdsOrdered } from "./matchmaking.service";
import { toUser } from "./events";
import { isUserOnline } from "../../websocket/socket";

async function loadActiveSession(userId: string, sessionId: string | undefined) {
  if (!sessionId) throw Errors.validation("sessionId is required.");
  const s = await prisma.randomChatSession.findUnique({ where: { id: sessionId } });
  // 404 for "not yours" so ids can't be probed.
  if (!s || (s.user1Id !== userId && s.user2Id !== userId)) throw Errors.notFound("Session");
  return s;
}

export function partnerOf(s: { user1Id: string; user2Id: string }, userId: string) {
  return s.user1Id === userId ? s.user2Id : s.user1Id;
}

export async function sendMessage(userId: string, sessionId: string | undefined, content: string | undefined, clientId?: string) {
  const s = await loadActiveSession(userId, sessionId);
  if (s.status !== "ACTIVE") throw Errors.forbidden("This chat has ended.");
  await assertNotBanned(userId);

  const text = (content ?? "").replace(/\u0000/g, "").trim();
  if (!text) throw Errors.validation("Message can't be empty.");
  if (text.length > env.RC_MAX_MESSAGE_LENGTH) throw Errors.validation(`Messages are limited to ${env.RC_MAX_MESSAGE_LENGTH} characters.`);

  // Retried send of a message we already stored: return it, don't duplicate.
  if (clientId) {
    const dup = await prisma.randomChatMessage.findFirst({ where: { sessionId: s.id, senderId: userId, clientId } });
    if (dup) return { message: dup, recipientId: partnerOf(s, userId), duplicate: true };
  }

  const wait = messageLimiter.take(userId);
  if (wait > 0) throw rateLimited(wait);

  const verdict = checkMessageContent(text);
  if (!verdict.ok) {
    noteFilteredMessage(userId);
    throw Errors.validation(verdict.reason);
  }

  // Flooding with the same line is the most common bot/spam pattern.
  const recent = await prisma.randomChatMessage.findMany({
    where: { senderId: userId, createdAt: { gte: new Date(Date.now() - 60_000) } },
    orderBy: { createdAt: "desc" },
    take: 3,
    select: { content: true },
  });
  const norm = normalizeForDuplicateCheck(text);
  if (recent.length >= 3 && recent.every((r) => normalizeForDuplicateCheck(r.content) === norm)) {
    noteSpamMessage(userId);
    throw Errors.validation("Please don't repeat the same message.");
  }

  const partnerId = partnerOf(s, userId);
  // A block that landed between match and send must stop delivery immediately.
  const blocked = await prisma.block.findFirst({
    where: { OR: [{ blockerId: userId, blockedId: partnerId }, { blockerId: partnerId, blockedId: userId }] },
    select: { id: true },
  });
  if (blocked) throw Errors.forbidden("You can't message this person.");

  const message = await prisma.randomChatMessage.create({
    data: {
      sessionId: s.id,
      senderId: userId,
      clientId: clientId?.slice(0, 64) ?? null,
      content: text,
      deliveredAt: isUserOnline(partnerId) ? new Date() : null,
    },
  });
  return { message, recipientId: partnerId, duplicate: false };
}

export async function markRead(userId: string, sessionId: string | undefined) {
  const s = await loadActiveSession(userId, sessionId);
  const now = new Date();
  const res = await prisma.randomChatMessage.updateMany({
    where: { sessionId: s.id, senderId: { not: userId }, readAt: null },
    data: { readAt: now, deliveredAt: now },
  });
  return { count: res.count, partnerId: partnerOf(s, userId), readAt: now };
}

export async function history(userId: string, sessionId: string) {
  const s = await loadActiveSession(userId, sessionId);
  const rows = await prisma.randomChatMessage.findMany({ where: { sessionId: s.id }, orderBy: { createdAt: "asc" }, take: 500 });
  return rows.map((m) => toMessageDto(m, userId));
}

export { userIdsOrdered };

// One delivery path for socket and REST sends. Each participant gets their own
// copy (with `mine` set for them) and no sender id is ever included.
export function broadcastMessage(
  message: { id: string; sessionId: string; senderId: string; clientId: string | null; content: string; deliveredAt: Date | null; readAt: Date | null; createdAt: Date },
  recipientId: string
) {
  toUser(message.senderId, "random_chat:message", toMessageDto(message, message.senderId));
  toUser(recipientId, "random_chat:message", toMessageDto(message, recipientId));
}
