import { z } from "zod";

export const createBlockSchema = z.object({
  userId: z.string().min(1),
});

export const createReportSchema = z.object({
  reportedId: z.string().min(1),
  reason: z.string().min(3).max(500),
  targetType: z.enum(["PROFILE", "PHOTO", "MESSAGE", "USER"]),
  targetId: z.string().min(1).optional(),
});
