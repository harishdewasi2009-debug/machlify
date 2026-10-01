import { Request, Response } from "express";
import { Errors } from "../utils/apiError";
import { createSwipeSchema } from "../validators/swipe.validator";
import * as swipeService from "../services/swipe.service";

export async function create(req: Request, res: Response) {
  if (!req.userId) throw Errors.unauthorized();
  const { targetUserId, liked } = createSwipeSchema.parse(req.body);
  const result = await swipeService.recordSwipe(req.userId, targetUserId, liked);
  res.status(201).json({ success: true, data: result });
}
