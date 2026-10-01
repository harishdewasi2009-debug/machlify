import { prisma } from "../../config/prisma";
import { env } from "../../config/env";
import { Errors } from "../../utils/apiError";
import { logAdminAction } from "../adminAudit.service";
import { applyBan, liftBan } from "./safety";
import { endSession } from "./matchmaking.service";
import { getIO } from "../../websocket/socket";

const PAGE = 25;

export async function dashboard() {
  const day = new Date(Date.now() - 24 * 3_600_000);
  const [online, waiting, active, ended, openReports, blocks24h, openAlerts, bans, ban24h] = await Promise.all([
    prisma.userPresence.count({ where: { online: true } }),
    prisma.randomChatQueue.count({ where: { status: "WAITING" } }),
    prisma.randomChatSession.count({ where: { status: "ACTIVE" } }),
    prisma.randomChatSession.findMany({ where: { status: "ENDED", endedAt: { gte: day } }, select: { startedAt: true, endedAt: true } }),
    prisma.report.count({ where: { targetType: "RANDOM_CHAT", status: "OPEN" } }),
    prisma.block.count({ where: { createdAt: { gte: day } } }),
    prisma.randomChatAbuseAlert.count({ where: { resolvedAt: null } }),
    prisma.randomChatBan.count(),
    prisma.randomChatBan.count({ where: { createdAt: { gte: day } } }),
  ]);
  const durations = ended.map((s) => ((s.endedAt as Date).getTime() - s.startedAt.getTime()) / 1000).filter((d) => d >= 0);
  const avg = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0;
  return {
    onlineUsers: online,
    liveSockets: getIO()?.engine.clientsCount ?? null,
    waitingUsers: waiting,
    activeSessions: active,
    avgSessionSeconds24h: avg,
    sessions24h: ended.length,
    openReports,
    blocks24h,
    openAlerts,
    activeBans: bans,
    bansLast24h: ban24h,
  };
}

export async function listSessions(cursor?: string) {
  const rows = await prisma.randomChatSession.findMany({
    where: { status: "ACTIVE" },
    orderBy: { startedAt: "desc" },
    take: PAGE,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: { id: true, startedAt: true, user1Id: true, user2Id: true, _count: { select: { messages: true } } },
  });
  // Metadata only — message bodies are never part of this listing.
  return {
    sessions: rows.map((r) => ({ id: r.id, startedAt: r.startedAt, userIds: [r.user1Id, r.user2Id], messageCount: r._count.messages })),
    nextCursor: rows.length === PAGE ? rows[rows.length - 1].id : null,
  };
}

export async function adminEndSession(adminId: string, sessionId: string) {
  const ok = await endSession(sessionId, null, "ADMIN");
  if (!ok) throw Errors.notFound("Active session");
  await logAdminAction(adminId, "RC_END_SESSION", "RandomChatSession", sessionId);
}

export async function listAlerts(resolved: boolean, cursor?: string) {
  const rows = await prisma.randomChatAbuseAlert.findMany({
    where: resolved ? {} : { resolvedAt: null },
    orderBy: { createdAt: "desc" },
    take: PAGE,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: { user: { select: { email: true, status: true } } },
  });
  return { alerts: rows, nextCursor: rows.length === PAGE ? rows[rows.length - 1].id : null };
}

export async function resolveAlert(adminId: string, alertId: string) {
  const r = await prisma.randomChatAbuseAlert.updateMany({ where: { id: alertId, resolvedAt: null }, data: { resolvedAt: new Date() } });
  if (r.count === 0) throw Errors.notFound("Alert");
  await logAdminAction(adminId, "RC_RESOLVE_ALERT", "RandomChatAbuseAlert", alertId);
}

export async function listBans() {
  const rows = await prisma.randomChatBan.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { user: { select: { email: true, status: true } } },
  });
  return { bans: rows };
}

export async function banUser(adminId: string, userId: string, reason: string, hours?: number) {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!u) throw Errors.notFound("User");
  await applyBan(userId, reason, { hours, adminId });
  // Kick them out of whatever they're doing right now.
  await prisma.randomChatQueue.deleteMany({ where: { userId, status: "WAITING" } });
  const active = await prisma.randomChatSession.findMany({
    where: { status: "ACTIVE", OR: [{ user1Id: userId }, { user2Id: userId }] },
    select: { id: true },
  });
  for (const s of active) await endSession(s.id, null, "ADMIN");
  await logAdminAction(adminId, "RC_BAN_USER", "User", userId, { reason, hours: hours ?? "permanent" });
}

export async function unbanUser(adminId: string, userId: string) {
  await liftBan(userId);
  await logAdminAction(adminId, "RC_UNBAN_USER", "User", userId);
}

// Review = aggregate behaviour only, no message content.
export async function reviewUser(adminId: string, userId: string) {
  const day30 = new Date(Date.now() - 30 * 86_400_000);
  const [user, reportsAgainst, reportsBy, sessions, blocksReceived, alerts, ban] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, status: true, verificationStatus: true, createdAt: true } }),
    prisma.report.count({ where: { reportedId: userId } }),
    prisma.report.count({ where: { reporterId: userId } }),
    prisma.randomChatSession.count({ where: { OR: [{ user1Id: userId }, { user2Id: userId }], startedAt: { gte: day30 } } }),
    prisma.block.count({ where: { blockedId: userId } }),
    prisma.randomChatAbuseAlert.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 20 }),
    prisma.randomChatBan.findUnique({ where: { userId } }),
  ]);
  if (!user) throw Errors.notFound("User");
  await logAdminAction(adminId, "RC_REVIEW_USER", "User", userId);
  return { user, reportsAgainst, reportsBy, sessions30d: sessions, blocksReceived, alerts, ban };
}

export async function listRandomChatReports(status: string | undefined, cursor?: string) {
  const rows = await prisma.report.findMany({
    where: { targetType: "RANDOM_CHAT", ...(status ? { status } : {}) },
    orderBy: { createdAt: "desc" },
    take: PAGE,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: { reporter: { select: { email: true } }, reported: { select: { email: true, status: true } } },
  });
  return { reports: rows, nextCursor: rows.length === PAGE ? rows[rows.length - 1].id : null };
}

// Disabled unless RC_ADMIN_CAN_VIEW_REPORTED_MESSAGES=true, ADMIN role only,
// only for a session that actually has a report against it, and every read is
// written to the audit log.
export async function reportedMessages(adminId: string, reportId: string) {
  if (!env.RC_ADMIN_CAN_VIEW_REPORTED_MESSAGES) {
    throw Errors.forbidden("Viewing reported chat content is disabled by platform policy.");
  }
  const report = await prisma.report.findUnique({ where: { id: reportId } });
  if (!report?.chatSessionId) throw Errors.notFound("Report");
  const messages = await prisma.randomChatMessage.findMany({
    where: { sessionId: report.chatSessionId },
    orderBy: { createdAt: "asc" },
    take: 500,
    select: { senderId: true, content: true, createdAt: true },
  });
  await logAdminAction(adminId, "RC_VIEW_REPORTED_MESSAGES", "Report", reportId, { sessionId: report.chatSessionId });
  return {
    reporterId: report.reporterId,
    messages: messages.map((m) => ({ fromReporter: m.senderId === report.reporterId, content: m.content, createdAt: m.createdAt })),
  };
}
