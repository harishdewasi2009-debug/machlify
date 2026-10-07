import { z } from "zod";

export const listMessagesQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
});

export const sendMessageSchema = z.object({
  content: z.string().min(1).max(2000),
  // IMAGE/AUDIO are created only by the media upload endpoint, never by a client-supplied string.
  type: z.enum(["TEXT", "LOCATION"]).optional().default("TEXT"),
});
