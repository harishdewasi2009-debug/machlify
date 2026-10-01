import { z } from "zod";

export const createSwipeSchema = z.object({
  targetUserId: z.string().min(1),
  liked: z.boolean(),
});
