import { prisma } from "../config/prisma";

const PAGE_SIZE = 25;
const DEFAULT_FLAG_THRESHOLD = 3;

export async function listBlocks(cursor?: string) {
  const blocks = await prisma.block.findMany({
    orderBy: { createdAt: "desc" },
    take: PAGE_SIZE,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: {
      blocker: { select: { email: true } },
      blocked: { select: { email: true } },
    },
  });

  const nextCursor = blocks.length === PAGE_SIZE ? blocks[blocks.length - 1].id : null;
  return { blocks, nextCursor };
}

// Users who have accumulated at least `minReports` reports against them and
// aren't already suspended — a simple, transparent risk signal (no opaque
// scoring model) surfaced for a human to actually look at, not to
// auto-action.
export async function listFlaggedUsers(minReports: number = DEFAULT_FLAG_THRESHOLD) {
  const grouped = await prisma.report.groupBy({
    by: ["reportedId"],
    _count: { reportedId: true },
    having: { reportedId: { _count: { gte: minReports } } },
  });

  if (grouped.length === 0) return { users: [] };

  const reportCountByUserId = new Map(grouped.map((g) => [g.reportedId, g._count.reportedId]));

  const users = await prisma.user.findMany({
    where: { id: { in: grouped.map((g) => g.reportedId) }, status: { not: "SUSPENDED" } },
    select: { id: true, email: true, status: true, createdAt: true, profile: { select: { displayName: true } } },
  });

  return {
    users: users
      .map((u) => ({ ...u, reportCount: reportCountByUserId.get(u.id) ?? 0 }))
      .sort((a, b) => b.reportCount - a.reportCount),
  };
}
