import { prisma } from "../config/prisma";
import { Errors } from "../utils/apiError";
import { logAdminAction } from "./adminAudit.service";
import { suspendUser } from "./adminUsers.service";

const PAGE_SIZE = 25;
const VALID_STATUSES = ["OPEN", "INVESTIGATING", "RESOLVED", "DISMISSED"] as const;
type ReportStatus = (typeof VALID_STATUSES)[number];

export async function listReports(status: ReportStatus | undefined, cursor?: string) {
  const reports = await prisma.report.findMany({
    where: status ? { status } : { status: "OPEN" },
    orderBy: { createdAt: "asc" },
    take: PAGE_SIZE,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: {
      reporter: { select: { email: true } },
      reported: { select: { email: true, status: true } },
    },
  });

  const nextCursor = reports.length === PAGE_SIZE ? reports[reports.length - 1].id : null;
  return { reports, nextCursor };
}

export async function updateReportStatus(adminUserId: string, reportId: string, status: ReportStatus) {
  const report = await prisma.report.findUnique({ where: { id: reportId } });
  if (!report) throw Errors.notFound("Report");

  await prisma.report.update({ where: { id: reportId }, data: { status } });
  await logAdminAction(adminUserId, "UPDATE_REPORT_STATUS", "Report", reportId, { status });
}

// A one-click path from "this report is credible" straight to account
// action, still fully audited (both the underlying suspendUser call and
// this wrapper log the action, with this one tying it back to the specific
// report that triggered it).
export async function suspendReportedUser(adminUserId: string, reportId: string, reason: string) {
  const report = await prisma.report.findUnique({ where: { id: reportId } });
  if (!report) throw Errors.notFound("Report");

  await suspendUser(adminUserId, report.reportedId, reason);
  await prisma.report.update({ where: { id: reportId }, data: { status: "RESOLVED" } });
  await logAdminAction(adminUserId, "SUSPEND_VIA_REPORT", "Report", reportId, { reason });
}
