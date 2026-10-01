import { Request, Response } from "express";
import { z } from "zod";
import * as adminAuditService from "../services/adminAudit.service";

const cursorQuerySchema = z.object({ cursor: z.string().optional() });

export async function list(req: Request, res: Response) {
  const { cursor } = cursorQuerySchema.parse(req.query);
  const result = await adminAuditService.listAuditLogs(cursor);
  res.json({ success: true, data: result });
}
