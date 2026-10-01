import { Request, Response } from "express";
import { Errors } from "../utils/apiError";
import {
  updateInterestsSchema,
  updateLocationSchema,
  updatePreferencesSchema,
  updateProfileSchema,
} from "../validators/profile.validator";
import * as profileService from "../services/profile.service";

export async function getMe(req: Request, res: Response) {
  if (!req.userId) throw Errors.unauthorized();
  const profile = await profileService.getMyProfile(req.userId);
  res.json({ success: true, data: { profile } });
}

export async function updateMe(req: Request, res: Response) {
  if (!req.userId) throw Errors.unauthorized();
  const input = updateProfileSchema.parse(req.body);
  await profileService.updateProfile(req.userId, input);
  res.json({ success: true, data: { updated: true } });
}

export async function updateLocation(req: Request, res: Response) {
  if (!req.userId) throw Errors.unauthorized();
  const { latitude, longitude } = updateLocationSchema.parse(req.body);
  await profileService.updateLocation(req.userId, latitude, longitude);
  res.json({ success: true, data: { updated: true } });
}

export async function updatePreferences(req: Request, res: Response) {
  if (!req.userId) throw Errors.unauthorized();
  const input = updatePreferencesSchema.parse(req.body);
  await profileService.updatePreferences(req.userId, input);
  res.json({ success: true, data: { updated: true } });
}

export async function updateInterests(req: Request, res: Response) {
  if (!req.userId) throw Errors.unauthorized();
  const { interests } = updateInterestsSchema.parse(req.body);
  await profileService.updateInterests(req.userId, interests);
  res.json({ success: true, data: { updated: true } });
}
