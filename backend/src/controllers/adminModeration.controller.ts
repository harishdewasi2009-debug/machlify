import { Request, Response } from "express";
import { Errors } from "../utils/apiError";
import {
  photoStatusQuerySchema,
  verificationStatusQuerySchema,
  rejectSchema,
} from "../validators/admin.validator";
import * as adminModerationService from "../services/adminModeration.service";

export async function listPhotos(req: Request, res: Response) {
  const { status, cursor } = photoStatusQuerySchema.parse(req.query);
  const result = await adminModerationService.listPhotos(status, cursor);
  res.json({ success: true, data: result });
}

export async function approvePhoto(req: Request, res: Response) {
  if (!req.adminUserId) throw Errors.adminUnauthorized();
  await adminModerationService.approvePhoto(req.adminUserId, req.params.id);
  res.json({ success: true, data: null });
}

export async function rejectPhoto(req: Request, res: Response) {
  if (!req.adminUserId) throw Errors.adminUnauthorized();
  const { reason } = rejectSchema.parse(req.body);
  await adminModerationService.rejectPhoto(req.adminUserId, req.params.id, reason);
  res.json({ success: true, data: null });
}

export async function listVerifications(req: Request, res: Response) {
  const { status, cursor } = verificationStatusQuerySchema.parse(req.query);
  const result = await adminModerationService.listVerifications(status, cursor);
  res.json({ success: true, data: result });
}

export async function approveVerification(req: Request, res: Response) {
  if (!req.adminUserId) throw Errors.adminUnauthorized();
  await adminModerationService.approveVerification(req.adminUserId, req.params.id);
  res.json({ success: true, data: null });
}

export async function rejectVerification(req: Request, res: Response) {
  if (!req.adminUserId) throw Errors.adminUnauthorized();
  const { reason } = rejectSchema.parse(req.body);
  await adminModerationService.rejectVerification(req.adminUserId, req.params.id, reason);
  res.json({ success: true, data: null });
}
