import { z } from "zod";

export const updateProfileSchema = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
  bio: z.string().trim().max(500).optional(),
  education: z.string().trim().max(120).optional(),
  occupation: z.string().trim().max(120).optional(),
  languages: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
  relationshipIntent: z.string().trim().max(60).optional(),
});

export const updateLocationSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

export const updatePreferencesSchema = z.object({
  minAge: z.number().int().min(18).max(99),
  maxAge: z.number().int().min(18).max(99),
  // Distance is no longer used for matching; accepted (and ignored) for old clients.
  maxDistanceKm: z.number().int().min(1).max(500).optional(),
  genders: z.array(z.string().trim().min(1).max(40)).min(1).max(10),
}).refine((data) => data.minAge <= data.maxAge, {
  message: "minAge must be less than or equal to maxAge",
  path: ["minAge"],
});

export const updateInterestsSchema = z.object({
  interests: z.array(z.string().trim().min(1).max(40)).max(20),
});
