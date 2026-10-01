import { prisma } from "../config/prisma";
import { Errors } from "../utils/apiError";

interface CreateReportInput {
  reportedId: string;
  reason: string;
  targetType: "PROFILE" | "PHOTO" | "MESSAGE" | "USER";
  targetId?: string;
}

export async function createReport(reporterId: string, input: CreateReportInput) {
  if (reporterId === input.reportedId) throw Errors.validation("You can't report yourself.");

  const target = await prisma.user.findUnique({ where: { id: input.reportedId } });
  if (!target) throw Errors.notFound("User");

  // Reports always land in the moderation queue as OPEN regardless of who
  // filed them — status transitions (INVESTIGATING/RESOLVED/DISMISSED) are
  // an admin-only action, never something the reporter or reported user can
  // set through this endpoint.
  return prisma.report.create({
    data: {
      reporterId,
      reportedId: input.reportedId,
      reason: input.reason,
      targetType: input.targetType,
      targetId: input.targetId,
      status: "OPEN",
    },
  });
}
