import { Request, Response } from "express";
import { Errors } from "../utils/apiError";
import * as matchService from "../services/match.service";

export async function list(req: Request, res: Response) {
  if (!req.userId) throw Errors.unauthorized();
  const matches = await matchService.listMatches(req.userId);
  res.json({ success: true, data: { matches } });
}

export async function remove(req: Request, res: Response) {
  if (!req.userId) throw Errors.unauthorized();
  await matchService.unmatch(req.userId, req.params.id);
  res.json({ success: true, data: { unmatched: true } });
}
