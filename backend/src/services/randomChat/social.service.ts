import { prisma } from "../../config/prisma";
import { Errors } from "../../utils/apiError";
import { createNotification } from "../notification.service";
import { joinUsersToConversation } from "../../websocket/socket";
import { blockUser } from "../block.service";
import { buildProfile } from "./card";
import { endSession, userIdsOrdered } from "./matchmaking.service";
import { partnerOf } from "./chat.service";
import { evaluateReportedUser, raiseAlert } from "./safety";
import { toUser } from "./events";

export const REPORT_REASONS = [
  "HARASSMENT", "SPAM", "SCAM", "IMPERSONATION", "INAPPROPRIATE_BEHAVIOR", "UNWANTED_CONTACT", "FAKE_PROFILE", "OTHER",
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

// Everything below is addressed by *session*, never by user id: the client
// never learns the other person's internal id, and a participant can't use
// these endpoints on someone they weren't actually paired with.
async function participantSession(userId: string, sessionId: string) {
  const s = await prisma.randomChatSession.findUnique({ where: { id: sessionId } });
  if (!s || (s.user1Id !== userId && s.user2Id !== userId)) throw Errors.notFound("Session");
  return { s, partnerId: partnerOf(s, userId) };
}

async function assertNotBlockedEitherWay(a: string, b: string) {
  const blk = await prisma.block.findFirst({
    where: { OR: [{ blockerId: a, blockedId: b }, { blockerId: b, blockedId: a }] },
    select: { id: true },
  });
  if (blk) throw Errors.notFound("Profile"); // same 404 as "doesn't exist": blocked profiles are hidden
}

export async function viewPartnerProfile(userId: string, sessionId: string) {
  const { partnerId } = await participantSession(userId, sessionId);
  await assertNotBlockedEitherWay(userId, partnerId);
  const partner = await prisma.user.findUnique({ where: { id: partnerId }, select: { status: true } });
  if (!partner || partner.status !== "ACTIVE") throw Errors.notFound("Profile");
  return buildProfile(userId, partnerId, true);
}

// A like from Random Chat is an ordinary Swipe, so mutual likes produce the
// same Match + Conversation as Discovery. Whether the *other* person has
// liked you is never revealed unless it completes a match.
export async function likePartner(userId: string, sessionId: string) {
  const { partnerId } = await participantSession(userId, sessionId);
  await assertNotBlockedEitherWay(userId, partnerId);

  await prisma.swipe.upsert({
    where: { actorId_targetId: { actorId: userId, targetId: partnerId } },
    update: { liked: true },
    create: { actorId: userId, targetId: partnerId, liked: true },
  });

  const reciprocal = await prisma.swipe.findUnique({ where: { actorId_targetId: { actorId: partnerId, targetId: userId } } });
  if (!reciprocal?.liked) return { liked: true, matched: false as const };

  const ids = userIdsOrdered(userId, partnerId);
  const { match, conversation, created } = await prisma.$transaction(async (tx) => {
    const existing = await tx.match.findUnique({ where: { userAId_userBId: ids }, include: { conversation: true } });
    if (existing) {
      // A previously-blocked-then-unblocked pair can have a dead match row; re-open it.
      if (existing.status !== "ACTIVE") await tx.match.update({ where: { id: existing.id }, data: { status: "ACTIVE" } });
      return { match: existing, conversation: existing.conversation, created: false };
    }
    const m = await tx.match.create({ data: ids });
    const c = await tx.conversation.create({ data: { matchId: m.id } });
    await tx.conversationMember.createMany({
      data: [{ conversationId: c.id, userId: ids.userAId }, { conversationId: c.id, userId: ids.userBId }],
    });
    return { match: m, conversation: c, created: true };
  });

  if (created) {
    if (conversation) joinUsersToConversation([userId, partnerId], conversation.id);
    await Promise.all([
      createNotification(userId, "MATCH", { matchId: match.id, source: "random_chat" }),
      createNotification(partnerId, "MATCH", { matchId: match.id, source: "random_chat" }),
    ]);
  }

  // Tell the other person live, so both see "It's a Match!" at once.
  const payload = { sessionId, conversationId: conversation?.id ?? null };
  toUser(partnerId, "random_chat:match", payload);
  return { liked: true, matched: true as const, conversationId: conversation?.id ?? null };
}

export async function blockPartner(userId: string, sessionId: string) {
  const { partnerId } = await participantSession(userId, sessionId);
  await blockUser(userId, partnerId); // existing service: also severs any Match
  await endSession(sessionId, userId, "BLOCKED");
  return { blocked: true };
}

export async function reportPartner(
  userId: string,
  sessionId: string,
  reason: ReportReason,
  description?: string
) {
  const { partnerId } = await participantSession(userId, sessionId);

  // Don't let one person spam the moderators about the same session.
  const already = await prisma.report.findFirst({ where: { reporterId: userId, chatSessionId: sessionId } });
  if (already) return { reportId: already.id, alreadyReported: true, offer: "BLOCK_AND_NEXT" as const };

  const report = await prisma.report.create({
    data: {
      reporterId: userId,
      reportedId: partnerId,
      reason,
      targetType: "RANDOM_CHAT",
      targetId: sessionId,
      chatSessionId: sessionId,
      description: description?.trim().slice(0, 1000) || null,
      status: "OPEN",
    },
  });

  const reportedCount = await prisma.report.count({ where: { reportedId: partnerId, status: "OPEN" } });
  if (reportedCount >= 2) await raiseAlert(partnerId, "MULTI_REPORT", `${reportedCount} open reports.`);
  const paused = await evaluateReportedUser(partnerId);
  if (paused) await endAllActiveFor(partnerId);

  return { reportId: report.id, alreadyReported: false, offer: "BLOCK_AND_NEXT" as const };
}

async function endAllActiveFor(userId: string) {
  const active = await prisma.randomChatSession.findMany({
    where: { status: "ACTIVE", OR: [{ user1Id: userId }, { user2Id: userId }] },
    select: { id: true },
  });
  for (const s of active) await endSession(s.id, null, "REPORTED");
}
