import { z } from "zod";

export const reorderPhotosSchema = z.object({
  order: z.array(z.string().min(1)).min(1).max(20),
});
