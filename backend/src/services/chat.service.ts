import { prisma } from "../config/prisma";
import { Errors } from "../utils/apiError";
import { createNotification } from "./notification.service";
import { randomUUID } from "crypto";
import { putObject, getObjectUrl } from "./storage.service";
import { CHAT_MEDIA_TYPES } from "../middleware/upload.middleware";

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

  // Real unread counts: messages from the other person that haven't been read.
  const unread = await prisma.message.groupBy({
    by: ["conversationId"],
    where: {
      conversationId: { in: memberships.map((m) => m.conversationId) },
      senderId: { not: userId },
      readAt: null,
      deletedAt: null,
    },
    _count: { _all: true },
  });
  const unreadByConversation = new Map(unread.map((u) => [u.conversationId, u._count._all]));

  return memberships
    .map((m) => {
      const other = m.conversation.members.find((mem) => mem.userId !== userId)?.user;
      const lastMessage = m.conversation.messages[0] ?? null;
      return {
        conversationId: m.conversationId,
        otherUser: other ? { id: other.id, name: other.profile?.displayName ?? "Matchify user" } : null,
        lastMessage: lastMessage
          ? {
              content: lastMessage.deletedAt ? null : previewFor(lastMessage.type, lastMessage.content),
              senderId: lastMessage.senderId,
              createdAt: lastMessage.createdAt,
              readAt: lastMessage.readAt,
            }
          : null,
        unreadCount: unreadByConversation.get(m.conversationId) ?? 0,
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
    messages: await Promise.all(messages.reverse().map(async (m) => ({
      id: m.id,
      conversationId: m.conversationId,
      senderId: m.senderId,
      content: m.deletedAt ? null : await resolveContent(m.type, m.content),
      type: m.type,
      readAt: m.readAt,
      deletedAt: m.deletedAt,
      createdAt: m.createdAt,
    }))),
    nextCursor,
  };
}

// Media messages store a storage key in `content`; clients get a loadable URL.
async function resolveContent(type: string, content: string | null): Promise<string | null> {
  if (!content) return content;
  if ((type === "IMAGE" || type === "AUDIO") && content.startsWith("chat/")) return getObjectUrl(content);
  return content;
}

function previewFor(type: string, content: string | null): string | null {
  if (type === "IMAGE") return "📷 Photo";
  if (type === "AUDIO") return "🎤 Voice message";
  if (type === "LOCATION") return "📍 Location";
  return content;
}

// The Content-Type a client sends is just a claim. Check the file's real leading bytes so a
// script/HTML/SVG file can't be uploaded under an image or audio label.
function bytesMatchDeclaredType(buf: Buffer, mime: string): boolean {
  const ascii = (from: number, to: number) => buf.subarray(from, to).toString("latin1");
  switch (mime) {
    case "image/jpeg":
      return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    case "image/png":
      return buf.length > 8 && buf[0] === 0x89 && ascii(1, 4) === "PNG";
    case "image/webp":
      return buf.length > 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
    case "audio/wav":
      return buf.length > 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE";
    case "audio/ogg":
      return buf.length > 4 && ascii(0, 4) === "OggS";
    case "audio/webm":
      return buf.length > 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3;
    case "audio/mp4":
      return buf.length > 12 && ascii(4, 8) === "ftyp";
    case "audio/mpeg":
      return buf.length > 3 && (ascii(0, 3) === "ID3" || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0));
    default:
      return false;
  }
}

export async function sendMediaMessage(userId: string, conversationId: string, file: Express.Multer.File) {
  const mime = (file.mimetype || "").split(";")[0];
  const spec = CHAT_MEDIA_TYPES[mime];
  if (!spec) throw Errors.validation("Unsupported file type. Use JPEG, PNG, WebP or an audio recording.");
  if (!file.buffer || !bytesMatchDeclaredType(file.buffer, mime)) {
    throw Errors.validation("That file doesn't look like a valid " + (spec.kind === "IMAGE" ? "image." : "audio recording."));
  }
  await assertMembership(userId, conversationId);
  const key = `chat/${conversationId}/${randomUUID()}.${spec.ext}`;
  await putObject(key, file.buffer, mime);
  // Internal path: this is the only place IMAGE/AUDIO messages may be created.
  return postMessage(userId, conversationId, key, spec.kind);
}

const GEO_CONTENT = /^geo:(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)$/;

// Public entry point used by the REST route and the socket handler. Clients may only create
// TEXT or LOCATION messages here. IMAGE/AUDIO messages carry a storage key and are created
// exclusively by sendMediaMessage — otherwise a user could send "type: IMAGE" with any string
// (e.g. a javascript: or tracking URL) as content and have it rendered in the other person's app.
export async function sendMessage(
  userId: string,
  conversationId: string | undefined,
  content: string | undefined,
  type = "TEXT"
) {
  if (type !== "TEXT" && type !== "LOCATION") {
    throw Errors.validation("Photos and voice messages must be uploaded, not sent as text.");
  }
  if (type === "LOCATION") {
    const m = GEO_CONTENT.exec((content ?? "").trim());
    if (!m || Math.abs(Number(m[1])) > 90 || Math.abs(Number(m[2])) > 180) {
      throw Errors.validation("Invalid location.");
    }
  }
  return postMessage(userId, conversationId, content, type);
}

async function postMessage(
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
    const sender = await prisma.profile.findUnique({ where: { userId }, select: { displayName: true } });
    await createNotification(otherMember.userId, "MESSAGE", {
      conversationId,
      fromUserId: userId,
      fromName: sender?.displayName ?? "Someone",
    });
  }

  return {
    id: message.id,
    conversationId: message.conversationId,
    senderId: message.senderId,
    content: await resolveContent(message.type, message.content),
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
  // Opening the chat also clears its "new message" notifications.
  try {
    await prisma.notification.updateMany({
      where: { userId, type: "MESSAGE", readAt: null, payload: { path: ["conversationId"], equals: conversationId } },
      data: { readAt: new Date() },
    });
  } catch (err) {
    console.error("[chat] could not clear message notifications:", err);
  }
}
