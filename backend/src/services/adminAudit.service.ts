import { prisma } from "../config/prisma";

const AUDIT_PAGE_SIZE = 50;

// Every mutating admin action goes through this — not scattered inline
// prisma.adminAuditLog.create calls in each service — so it's impossible to
// add a new sensitive admin action and forget to log it as long as the
// action calls this helper.
export async function logAdminAction(
  adminUserId: string,
  action: string,
  targetType?: string,
  targetId?: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  await prisma.adminAuditLog.create({
    data: { adminUserId, action, targetType, targetId, metadata: metadata ?? undefined },
  });
}

export async function listAuditLogs(cursor?: string) {
  const logs = await prisma.adminAuditLog.findMany({
    orderBy: { createdAt: "desc" },
    take: AUDIT_PAGE_SIZE,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: { adminUser: { select: { email: true, role: true } } },
  });

  const nextCursor = logs.length === AUDIT_PAGE_SIZE ? logs[logs.length - 1].id : null;
  return { logs, nextCursor };
}
