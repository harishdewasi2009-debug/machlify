import { Request, Response } from "express";
import { z } from "zod";
import * as adminSafetyService from "../services/adminSafety.service";

const cursorQuerySchema = z.object({ cursor: z.string().optional() });
const flaggedQuerySchema = z.object({ minReports: z.coerce.number().int().min(1).optional() });

export async function listBlocks(req: Request, res: Response) {
  const { cursor } = cursorQuerySchema.parse(req.query);
  const result = await adminSafetyService.listBlocks(cursor);
  res.json({ success: true, data: result });
}

export async function listFlaggedUsers(req: Request, res: Response) {
  const { minReports } = flaggedQuerySchema.parse(req.query);
  const result = await adminSafetyService.listFlaggedUsers(minReports);
  res.json({ success: true, data: result });
}
