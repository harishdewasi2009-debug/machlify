import { Request, Response } from "express";
import { Errors } from "../utils/apiError";
import { createReportSchema } from "../validators/safety.validator";
import * as reportService from "../services/report.service";

export async function create(req: Request, res: Response) {
  if (!req.userId) throw Errors.unauthorized();
  const input = createReportSchema.parse(req.body);
  const report = await reportService.createReport(req.userId, input);
  res.status(201).json({ success: true, data: { reportId: report.id, status: report.status } });
}
