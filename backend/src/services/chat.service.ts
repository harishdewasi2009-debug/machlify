import { prisma } from "../config/prisma";
import { Errors } from "../utils/apiError";
import { createNotification } from "./notification.service";

const MESSAGE_PAGE_SIZE = 30;

async function assertMembership(userId: string, conversationId: string) {
  const membership = await prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
  });
  // 404 rather than 403 — a caller guessing at conversation ids shouldn't be
  // able to tell "doesn't exist" apart from "exists but isn't yours".
  if (!membership) throw Errors.notFound("Conversation");
}

async function assertNotBlocked(userId: string, otherUserId: string) {
  const [blockedByMe, blockedMe] = await Promise.all([
    prisma.block.findUnique({ where: { blockerId_blockedId: { blockerId: userId, blockedId: otherUserId } } }),
    prisma.block.findUnique({ where: { blockerId_blockedId: { blockerId: otherUserId, blockedId: userId } } }),
  ]);
  if (blockedByMe || blockedMe) throw Errors.forbidden("You can't message this user.");
}

export async function listConversations(userId: string) {
  const memberships = await prisma.conversationMember.findMany({
    where: { userId },
    include: {
      conversation: {
        include: {
          members: { include: { user: { include: { profile: true } } } },
          messages: { orderBy: { createdAt: "desc" }, take: 1 },
        },
      },
    },
  });

  return memberships
    .map((m) => {
      const other = m.conversation.members.find((mem) => mem.userId !== userId)?.user;
      const lastMessage = m.conversation.messages[0] ?? null;
      return {
        conversationId: m.conversationId,
        otherUser: other ? { id: other.id, name: other.profile?.displayName ?? "Matchify user" } : null,
        lastMessage: lastMessage
          ? {
              content: lastMessage.deletedAt ? null : lastMessage.content,
              senderId: lastMessage.senderId,
              createdAt: lastMessage.createdAt,
              readAt: lastMessage.readAt,
            }
          : null,
        updatedAt: lastMessage?.createdAt ?? m.conversation.createdAt,
      };
    })
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

export async function getMessages(userId: string, conversationId: string, cursor?: string) {
  await assertMembership(userId, conversationId);

  const messages = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    take: MESSAGE_PAGE_SIZE,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const nextCursor = messages.length === MESSAGE_PAGE_SIZE ? messages[messages.length - 1].id : null;

  return {
    messages: messages.reverse().map((m) => ({
      id: m.id,
      conversationId: m.conversationId,
      senderId: m.senderId,
      content: m.deletedAt ? null : m.content,
      type: m.type,
      readAt: m.readAt,
      deletedAt: m.deletedAt,
      createdAt: m.createdAt,
    })),
    nextCursor,
  };
}

export async function sendMessage(
  userId: string,
  conversationId: string | undefined,
  content: string | undefined,
  type = "TEXT"
) {
  if (!conversationId) throw Errors.validation("conversationId is required.");
  const trimmed = content?.trim();
  if (!trimmed) throw Errors.validation("Message content is required.");
  if (trimmed.length > 2000) throw Errors.validation("Message is too long.");

  await assertMembership(userId, conversationId);

  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { members: true, match: true },
  });
  if (!conversation) throw Errors.notFound("Conversation");
  if (conversation.match.status !== "ACTIVE") {
    throw Errors.forbidden("This match is no longer active.");
  }

  const otherMember = conversation.members.find((m) => m.userId !== userId);
  if (otherMember) await assertNotBlocked(userId, otherMember.userId);

  const message = await prisma.message.create({
    data: { conversationId, senderId: userId, content: trimmed, type },
  });

  if (otherMember) {
    await createNotification(otherMember.userId, "MESSAGE", { conversationId, fromUserId: userId });
  }

  return {
    id: message.id,
    conversationId: message.conversationId,
    senderId: message.senderId,
    content: message.content,
    type: message.type,
    readAt: message.readAt,
    createdAt: message.createdAt,
  };
}

export async function markConversationRead(userId: string, conversationId: string) {
  await assertMembership(userId, conversationId);
  await prisma.message.updateMany({
    where: { conversationId, senderId: { not: userId }, readAt: null },
    data: { readAt: new Date() },
  });
}
