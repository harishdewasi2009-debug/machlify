import { prisma } from "../config/prisma";
import { Errors } from "../utils/apiError";
import { getObjectUrl } from "./storage.service";

export async function listMatches(userId: string) {
  const matches = await prisma.match.findMany({
    where: { OR: [{ userAId: userId }, { userBId: userId }], status: "ACTIVE" },
    include: {
      userA: { include: { profile: true, photos: { where: { isPrimary: true }, take: 1 } } },
      userB: { include: { profile: true, photos: { where: { isPrimary: true }, take: 1 } } },
      conversation: true,
    },
    orderBy: { createdAt: "desc" },
  });

  return Promise.all(
    matches.map(async (m) => {
      const other = m.userAId === userId ? m.userB : m.userA;
      const primaryPhoto = other.photos[0];
      return {
        matchId: m.id,
        conversationId: m.conversation?.id ?? null,
        createdAt: m.createdAt,
        user: {
          id: other.id,
          name: other.profile?.displayName ?? "Matchify user",
          primaryPhoto: primaryPhoto?.thumbnailKey ? await getObjectUrl(primaryPhoto.thumbnailKey) : null,
        },
      };
    })
  );
}

export async function unmatch(userId: string, matchId: string) {
  const match = await prisma.match.findUnique({ where: { id: matchId } });
  if (!match || (match.userAId !== userId && match.userBId !== userId)) {
    throw Errors.notFound("Match");
  }
  if (match.status !== "ACTIVE") return;

  await prisma.match.update({ where: { id: matchId }, data: { status: "UNMATCHED" } });
}
