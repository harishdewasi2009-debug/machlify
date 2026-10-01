import { Request, Response } from "express";
import { Errors } from "../utils/apiError";
import { generateTurnCredentials } from "../utils/turnCredentials";
import * as callService from "../services/call.service";

export async function turnCredentials(req: Request, res: Response) {
  if (!req.userId) throw Errors.unauthorized();
  const iceServers = generateTurnCredentials(req.userId);
  res.json({ success: true, data: { iceServers } });
}

export async function history(req: Request, res: Response) {
  if (!req.userId) throw Errors.unauthorized();
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
  const result = await callService.listCallHistory(req.userId, cursor);
  res.json({ success: true, data: result });
}

export async function getOne(req: Request, res: Response) {
  if (!req.userId) throw Errors.unauthorized();
  const call = await callService.getCall(req.userId, req.params.id);
  res.json({ success: true, data: { call } });
}
