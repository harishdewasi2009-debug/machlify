import { cleanupUser as cleanupRandomChatUser } from "./randomChat/matchmaking.service";
import { prisma } from "../config/prisma";
import { Errors } from "../utils/apiError";
import { logAdminAction } from "./adminAudit.service";

const PAGE_SIZE = 25;

interface ListUsersFilter {
  query?: string;
  status?: string;
  verificationStatus?: string;
  cursor?: string;
}

export async function listUsers(filter: ListUsersFilter) {
  const where = {
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.verificationStatus ? { verificationStatus: filter.verificationStatus } : {}),
    ...(filter.query
      ? {
          OR: [
            { email: { contains: filter.query, mode: "insensitive" as const } },
            { profile: { displayName: { contains: filter.query, mode: "insensitive" as const } } },
          ],
        }
      : {}),
  };

  const users = await prisma.user.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: PAGE_SIZE,
    ...(filter.cursor ? { cursor: { id: filter.cursor }, skip: 1 } : {}),
    select: {
      id: true,
      email: true,
      status: true,
      verificationStatus: true,
      emailVerified: true,
      createdAt: true,
      profile: { select: { displayName: true, isDiscoverable: true } },
    },
  });

  const nextCursor = users.length === PAGE_SIZE ? users[users.length - 1].id : null;
  return { users, nextCursor };
}

export async function getUserDetail(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      profile: true,
      subscriptions: { orderBy: { createdAt: "desc" }, take: 5 },
      payments: { orderBy: { createdAt: "desc" }, take: 5 },
      verificationSessions: { orderBy: { createdAt: "desc" }, take: 5 },
    },
  });
  if (!user) throw Errors.notFound("User");

  const [photoCount, reportsFiledCount, reportsReceivedCount, blockCount] = await Promise.all([
    prisma.photo.count({ where: { userId } }),
    prisma.report.count({ where: { reporterId: userId } }),
    prisma.report.count({ where: { reportedId: userId } }),
    prisma.block.count({ where: { blockedId: userId } }),
  ]);

  const { passwordHash, googleId, ...safeUser } = user;

  return { ...safeUser, photoCount, reportsFiledCount, reportsReceivedCount, blockCount };
}

export async function suspendUser(adminUserId: string, userId: string, reason: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw Errors.notFound("User");
  if (user.status === "SUSPENDED") return;

  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { status: "SUSPENDED" } }),
    // Kill every live session immediately — a suspension that leaves
    // existing access tokens/sockets working until they naturally expire
    // isn't a real suspension.
    prisma.session.updateMany({ where: { userId }, data: { revoked: true } }),
  ]);
  await cleanupRandomChatUser(userId, "ACCOUNT").catch(() => undefined);

  await logAdminAction(adminUserId, "SUSPEND_USER", "User", userId, { reason });
}

export async function restoreUser(adminUserId: string, userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw Errors.notFound("User");

  await prisma.user.update({ where: { id: userId }, data: { status: "ACTIVE" } });
  await logAdminAction(adminUserId, "RESTORE_USER", "User", userId);
}
