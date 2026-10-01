import { prisma } from "../config/prisma";
import { env } from "../config/env";
import { Errors } from "../utils/apiError";
import { createNotification } from "./notification.service";
import { joinUsersToConversation } from "../websocket/socket";

interface SwipeResult {
  liked: boolean;
  matched: boolean;
  matchId?: string;
  conversationId?: string;
}

async function isBlockedEitherWay(userId: string, otherId: string): Promise<boolean> {
  const [blockedByMe, blockedMe] = await Promise.all([
    prisma.block.findUnique({ where: { blockerId_blockedId: { blockerId: userId, blockedId: otherId } } }),
    prisma.block.findUnique({ where: { blockerId_blockedId: { blockerId: otherId, blockedId: userId } } }),
  ]);
  return Boolean(blockedByMe || blockedMe);
}

export async function recordSwipe(actorId: string, targetId: string, liked: boolean): Promise<SwipeResult> {
  if (actorId === targetId) throw Errors.validation("You can't swipe on your own profile.");

  // Belt-and-suspenders alongside the discovery-feed gate: swiping is a
  // direct API call and must never be reachable just because a client skips
  // the feed and posts a guessed targetUserId.
  const actor = await prisma.user.findUnique({ where: { id: actorId }, select: { verificationStatus: true } });
  if (env.REQUIRE_IDENTITY_VERIFICATION && actor?.verificationStatus !== "VERIFIED") {
    throw Errors.forbidden("Complete identity verification before swiping.");
  }

  const target = await prisma.user.findUnique({ where: { id: targetId } });
  // A blocked/nonexistent/inactive target all return the same 404 — the
  // caller shouldn't be able to tell "doesn't exist" apart from "blocked you"
  // by probing swipe responses.
  if (!target || target.status !== "ACTIVE" || (await isBlockedEitherWay(actorId, targetId))) {
    throw Errors.notFound("User");
  }

  const existing = await prisma.swipe.findUnique({
    where: { actorId_targetId: { actorId, targetId } },
  });
  if (existing) throw Errors.alreadySwiped();

  await prisma.swipe.create({ data: { actorId, targetId, liked } });

  if (!liked) {
    return { liked: false, matched: false };
  }

  const reciprocal = await prisma.swipe.findUnique({
    where: { actorId_targetId: { actorId: targetId, targetId: actorId } },
  });

  if (!reciprocal?.liked) {
    return { liked: true, matched: false };
  }

  // Match.@@unique([userAId, userBId]) only dedupes one specific ordering, so
  // ids are sorted here into a canonical order regardless of who liked last
  // — otherwise "A likes B" then "B likes A" could each try to create a
  // logically-identical-but-reversed match row.
  const [userAId, userBId] = [actorId, targetId].sort();

  const { match, conversation, alreadyExisted } = await prisma.$transaction(async (tx) => {
    const existingMatch = await tx.match.findUnique({
      where: { userAId_userBId: { userAId, userBId } },
      include: { conversation: true },
    });
    if (existingMatch) {
      return { match: existingMatch, conversation: existingMatch.conversation, alreadyExisted: true };
    }

    const createdMatch = await tx.match.create({ data: { userAId, userBId } });
    const createdConversation = await tx.conversation.create({ data: { matchId: createdMatch.id } });
    await tx.conversationMember.createMany({
      data: [
        { conversationId: createdConversation.id, userId: userAId },
        { conversationId: createdConversation.id, userId: userBId },
      ],
    });
    return { match: createdMatch, conversation: createdConversation, alreadyExisted: false };
  });

  if (!alreadyExisted) {
    if (conversation) joinUsersToConversation([actorId, targetId], conversation.id);
    await Promise.all([
      createNotification(actorId, "MATCH", { matchId: match.id, withUserId: targetId }),
      createNotification(targetId, "MATCH", { matchId: match.id, withUserId: actorId }),
    ]);
  }

  return { liked: true, matched: true, matchId: match.id, conversationId: conversation?.id };
}
