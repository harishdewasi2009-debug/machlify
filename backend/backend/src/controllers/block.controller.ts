import { Request, Response } from "express";
import { Errors } from "../utils/apiError";
import { createBlockSchema } from "../validators/safety.validator";
import * as blockService from "../services/block.service";

export async function create(req: Request, res: Response) {
  if (!req.userId) throw Errors.unauthorized();
  const { userId } = createBlockSchema.parse(req.body);
  await blockService.blockUser(req.userId, userId);
  res.status(201).json({ success: true, data: { blocked: true } });
}

export async function remove(req: Request, res: Response) {
  if (!req.userId) throw Errors.unauthorized();
  await blockService.unblockUser(req.userId, req.params.userId);
  res.json({ success: true, data: { blocked: false } });
}

export async function list(req: Request, res: Response) {
  if (!req.userId) throw Errors.unauthorized();
  const blocked = await blockService.listBlocked(req.userId);
  res.json({ success: true, data: { blocked } });
}
