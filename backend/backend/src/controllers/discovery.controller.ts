import { Request, Response } from "express";
import { z } from "zod";
import { Errors } from "../utils/apiError";
import { getDiscoveryFeed } from "../services/discovery.service";

const discoveryQuerySchema = z.object({
  cursor: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

export async function feed(req: Request, res: Response) {
  if (!req.userId) throw Errors.unauthorized();
  const { cursor, limit } = discoveryQuerySchema.parse(req.query);
  const result = await getDiscoveryFeed(req.userId, { cursor, limit });
  res.json({ success: true, data: result });
}
