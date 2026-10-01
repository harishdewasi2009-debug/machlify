import { Request, Response } from "express";
import { z } from "zod";
import { Errors } from "../utils/apiError";
import * as svc from "../services/randomChat/admin.service";

const aid = (req: Request) => {
  if (!req.adminUserId) throw Errors.adminUnauthorized();
  return req.adminUserId;
};
const ok = (res: Response, data: unknown = null) => res.json({ success: true, data });
const cursorQ = z.object({ cursor: z.string().optional(), status: z.string().optional(), resolved: z.enum(["true", "false"]).optional() });
const banSchema = z.object({ reason: z.string().min(3).max(500), hours: z.number().int().min(1).max(24 * 365).optional() });

export const stats = async (_q: Request, res: Response) => ok(res, await svc.dashboard());
export const sessions = async (req: Request, res: Response) => ok(res, await svc.listSessions(cursorQ.parse(req.query).cursor));
export const endSession = async (req: Request, res: Response) => { await svc.adminEndSession(aid(req), req.params.id); ok(res); };
export const alerts = async (req: Request, res: Response) => {
  const q = cursorQ.parse(req.query);
  ok(res, await svc.listAlerts(q.resolved === "true", q.cursor));
};
export const resolveAlert = async (req: Request, res: Response) => { await svc.resolveAlert(aid(req), req.params.id); ok(res); };
export const bans = async (_q: Request, res: Response) => ok(res, await svc.listBans());
export const ban = async (req: Request, res: Response) => {
  const b = banSchema.parse(req.body);
  await svc.banUser(aid(req), req.params.userId, b.reason, b.hours);
  ok(res);
};
export const unban = async (req: Request, res: Response) => { await svc.unbanUser(aid(req), req.params.userId); ok(res); };
export const review = async (req: Request, res: Response) => ok(res, await svc.reviewUser(aid(req), req.params.userId));
export const reports = async (req: Request, res: Response) => {
  const q = cursorQ.parse(req.query);
  ok(res, await svc.listRandomChatReports(q.status, q.cursor));
};
export const reportMessages = async (req: Request, res: Response) => ok(res, await svc.reportedMessages(aid(req), req.params.id));
