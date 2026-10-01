import { Request, Response } from "express";
import { z } from "zod";
import { Errors } from "../utils/apiError";
import { updatePreferencesSchema } from "../validators/push.validator";
import * as notificationService from "../services/notification.service";

const listQuerySchema = z.object({ cursor: z.string().min(1).optional() });

export async function list(req: Request, res: Response) {
  if (!req.userId) throw Errors.unauthorized();
  const { cursor } = listQuerySchema.parse(req.query);
  const result = await notificationService.listNotifications(req.userId, cursor);
  res.json({ success: true, data: result });
}

export async function markRead(req: Request, res: Response) {
  if (!req.userId) throw Errors.unauthorized();
  await notificationService.markNotificationRead(req.userId, req.params.id);
  res.json({ success: true, data: { read: true } });
}

export async function markAllRead(req: Request, res: Response) {
  if (!req.userId) throw Errors.unauthorized();
  await notificationService.markAllNotificationsRead(req.userId);
  res.json({ success: true, data: { read: true } });
}

export async function getPreferences(req: Request, res: Response) {
  if (!req.userId) throw Errors.unauthorized();
  const preferences = await notificationService.getPreferences(req.userId);
  res.json({ success: true, data: preferences });
}

export async function updatePreferences(req: Request, res: Response) {
  if (!req.userId) throw Errors.unauthorized();
  const { disabledTypes } = updatePreferencesSchema.parse(req.body);
  const preferences = await notificationService.updatePreferences(req.userId, disabledTypes);
  res.json({ success: true, data: preferences });
}
