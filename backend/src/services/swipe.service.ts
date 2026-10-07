import { prisma } from "../config/prisma";
import { env } from "../config/env";
import { Errors } from "../utils/apiError";
import { createNotification } from "./notification.service";
import { joinUsersToConversation } from "../websocket/socket";
import { calculateAge } from "../utils/age";
import { getObjectUrl } from "./storage.service";

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

  try {
    await prisma.swipe.create({ data: { actorId, targetId, liked } });
  } catch (err) {
    // Double-tap / two tabs: the unique (actorId, targetId) constraint fired. Same outcome as the check above.
    if ((err as { code?: string }).code === "P2002") throw Errors.alreadySwiped();
    throw err;
  }

  if (!liked) {
    return { liked: false, matched: false };
  }

  const reciprocal = await prisma.swipe.findUnique({
    where: { actorId_targetId: { actorId: targetId, targetId: actorId } },
  });

  if (!reciprocal?.liked) {
    // Real "someone liked you" notification (anonymous: who it was is shown in
    // the Likes You tab). Never blocks or fails the swipe itself.
    try {
      await createNotification(targetId, "LIKE", { fromUserId: actorId });
    } catch (err) {
      console.error("[swipe] could not create like notification:", err);
    }
    return { liked: true, matched: false };
  }

  // Match.@@unique([userAId, userBId]) only dedupes one specific ordering, so
  // ids are sorted here into a canonical order regardless of who liked last
  // — otherwise "A likes B" then "B likes A" could each try to create a
  // logically-identical-but-reversed match row.
  const [userAId, userBId] = [actorId, targetId].sort();

  const createMatchOnce = () => prisma.$transaction(async (tx) => {
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

  let result: Awaited<ReturnType<typeof createMatchOnce>>;
  try {
    result = await createMatchOnce();
  } catch (err) {
    // Both people liked at the same instant and each tried to create the match: the loser retries
    // and simply finds the winner's row.
    if ((err as { code?: string }).code !== "P2002") throw err;
    result = await createMatchOnce();
  }
  const { match, conversation, alreadyExisted } = result;

  if (!alreadyExisted) {
    if (conversation) joinUsersToConversation([actorId, targetId], conversation.id);
    const profiles = await prisma.profile.findMany({
      where: { userId: { in: [actorId, targetId] } },
      select: { userId: true, displayName: true },
    });
    const nameOf = (id: string) => profiles.find((p) => p.userId === id)?.displayName ?? "Someone";
    await Promise.all([
      createNotification(actorId, "MATCH", { matchId: match.id, withUserId: targetId, withName: nameOf(targetId) }),
      createNotification(targetId, "MATCH", { matchId: match.id, withUserId: actorId, withName: nameOf(actorId) }),
    ]);
  }

  return { liked: true, matched: true, matchId: match.id, conversationId: conversation?.id };
}

// People who liked this user and haven't been swiped on back yet (and aren't
// already matches / blocked). Real data for the "Likes You" tab and its badge.
export async function listLikesYou(userId: string) {
  const [incoming, mine, blocksMade, blocksReceived] = await Promise.all([
    prisma.swipe.findMany({ where: { targetId: userId, liked: true }, orderBy: { createdAt: "desc" }, take: 200 }),
    prisma.swipe.findMany({ where: { actorId: userId }, select: { targetId: true } }),
    prisma.block.findMany({ where: { blockerId: userId }, select: { blockedId: true } }),
    prisma.block.findMany({ where: { blockedId: userId }, select: { blockerId: true } }),
  ]);

  const excluded = new Set<string>([
    ...mine.map((s) => s.targetId),
    ...blocksMade.map((b) => b.blockedId),
    ...blocksReceived.map((b) => b.blockerId),
  ]);
  const likerIds = incoming.map((s) => s.actorId).filter((id) => !excluded.has(id));
  if (likerIds.length === 0) return [];

  const users = await prisma.user.findMany({
    where: { id: { in: likerIds }, status: "ACTIVE" },
    include: {
      profile: true,
      photos: { where: { status: "APPROVED" }, orderBy: { position: "asc" }, take: 1 },
    },
  });
  const byId = new Map(users.map((u) => [u.id, u]));

  return Promise.all(
    incoming
      .filter((s) => byId.has(s.actorId) && !excluded.has(s.actorId))
      .map(async (s) => {
        const u = byId.get(s.actorId)!;
        const photo = u.photos[0];
        return {
          id: u.id,
          name: u.profile?.displayName ?? "Matchify user",
          age: calculateAge(u.dateOfBirth),
          photo: photo?.mediumKey ? await getObjectUrl(photo.mediumKey) : photo?.thumbnailKey ? await getObjectUrl(photo.thumbnailKey) : null,
          likedAt: s.createdAt,
        };
      })
  );
}
