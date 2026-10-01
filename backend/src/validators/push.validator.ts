import { z } from "zod";
import { NOTIFICATION_TYPES } from "../utils/notificationTypes";

export const registerPushSubscriptionSchema = z.object({
  subscription: z.object({
    endpoint: z.string().url(),
    keys: z.object({
      p256dh: z.string().min(1),
      auth: z.string().min(1),
    }),
  }),
  platform: z.string().optional(),
});

export const unregisterPushSubscriptionSchema = z.object({
  endpoint: z.string().url(),
});

export const updatePreferencesSchema = z.object({
  disabledTypes: z.array(z.enum(NOTIFICATION_TYPES as unknown as [string, ...string[]])),
});
