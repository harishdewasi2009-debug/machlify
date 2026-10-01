import { z } from "zod";

export const listMessagesQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
});

export const sendMessageSchema = z.object({
  content: z.string().min(1).max(2000),
  type: z.enum(["TEXT", "IMAGE"]).optional().default("TEXT"),
});
