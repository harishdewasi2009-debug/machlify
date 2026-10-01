import { z } from "zod";
import { REPORT_REASONS } from "../services/randomChat/social.service";

export const settingsSchema = z.object({
  visibility: z.enum(["PUBLIC", "RANDOM_CHAT", "MATCH_ONLY", "PRIVATE"]).optional(),
  showAge: z.boolean().optional(),
  showLocation: z.boolean().optional(),
  showBio: z.boolean().optional(),
  showInterests: z.boolean().optional(),
  locationLabel: z.string().max(60).nullable().optional(),
  prefMinAge: z.number().int().min(18).max(99).optional(),
  prefMaxAge: z.number().int().min(18).max(99).optional(),
  prefGenders: z.array(z.string().max(30)).max(6).optional(),
  prefLanguages: z.array(z.string().max(30)).max(8).optional(),
  prefInterests: z.array(z.string().max(30)).max(12).optional(),
  prefSameRegion: z.boolean().optional(),
});

export const joinSchema = z.object({ captchaToken: z.string().max(4096).optional() });
export const nextSchema = z.object({ sessionId: z.string().min(1).optional(), captchaToken: z.string().max(4096).optional() });
export const messageSchema = z.object({ content: z.string().min(1).max(2000), clientId: z.string().min(1).max(64).optional() });
export const reportSchema = z.object({
  reason: z.enum(REPORT_REASONS),
  description: z.string().max(1000).optional(),
});
