import { Request, Response } from "express";
import { Errors } from "../utils/apiError";
import { reportStatusQuerySchema, reportStatusSchema, suspendUserSchema } from "../validators/admin.validator";
import * as adminReportsService from "../services/adminReports.service";

export async function list(req: Request, res: Response) {
  const { status, cursor } = reportStatusQuerySchema.parse(req.query);
  const result = await adminReportsService.listReports(status, cursor);
  res.json({ success: true, data: result });
}

export async function updateStatus(req: Request, res: Response) {
  if (!req.adminUserId) throw Errors.adminUnauthorized();
  const { status } = reportStatusSchema.parse(req.body);
  await adminReportsService.updateReportStatus(req.adminUserId, req.params.id, status);
  res.json({ success: true, data: null });
}

export async function suspendReported(req: Request, res: Response) {
  if (!req.adminUserId) throw Errors.adminUnauthorized();
  const { reason } = suspendUserSchema.parse(req.body);
  await adminReportsService.suspendReportedUser(req.adminUserId, req.params.id, reason);
  res.json({ success: true, data: null });
}
