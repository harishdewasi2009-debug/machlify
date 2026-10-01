import { prisma } from "../config/prisma";
import { Errors } from "../utils/apiError";

export async function blockUser(blockerId: string, blockedId: string) {
  if (blockerId === blockedId) throw Errors.validation("You can't block yourself.");

  const target = await prisma.user.findUnique({ where: { id: blockedId } });
  if (!target) throw Errors.notFound("User");

  await prisma.block.upsert({
    where: { blockerId_blockedId: { blockerId, blockedId } },
    update: {},
    create: { blockerId, blockedId },
  });

  // Blocking severs an existing match too, so the blocked user immediately
  // loses chat access rather than only being filtered out of future
  // discovery — chat.service also re-checks block state on every send as a
  // second line of defense in case this step is ever skipped.
  const [userAId, userBId] = [blockerId, blockedId].sort();
  await prisma.match.updateMany({
    where: { userAId, userBId, status: "ACTIVE" },
    data: { status: "BLOCKED" },
  });
}

export async function unblockUser(blockerId: string, blockedId: string) {
  await prisma.block.deleteMany({ where: { blockerId, blockedId } });
}

export async function listBlocked(blockerId: string) {
  const blocks = await prisma.block.findMany({
    where: { blockerId },
    include: { blocked: { include: { profile: true } } },
    orderBy: { createdAt: "desc" },
  });

  return blocks.map((b) => ({
    userId: b.blockedId,
    name: b.blocked.profile?.displayName ?? "Matchify user",
    blockedAt: b.createdAt,
  }));
}
