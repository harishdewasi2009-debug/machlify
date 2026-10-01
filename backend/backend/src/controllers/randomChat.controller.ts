import { Request, Response } from "express";
import { Errors } from "../utils/apiError";
import { env } from "../config/env";
import * as settingsService from "../services/randomChat/settings.service";
import * as mm from "../services/randomChat/matchmaking.service";
import * as chat from "../services/randomChat/chat.service";
import * as social from "../services/randomChat/social.service";
import { captchaConfigured } from "../services/randomChat/safety";
import { joinSchema, messageSchema, nextSchema, reportSchema, settingsSchema } from "../validators/randomChat.validator";

const uid = (req: Request) => {
  if (!req.userId) throw Errors.unauthorized();
  return req.userId;
};
const ok = (res: Response, data: unknown, status = 200) => res.status(status).json({ success: true, data });

export async function config(_req: Request, res: Response) {
  ok(res, {
    minAge: env.MIN_AGE_YEARS,
    maxMessageLength: env.RC_MAX_MESSAGE_LENGTH,
    captcha: captchaConfigured ? { provider: "turnstile", siteKey: env.TURNSTILE_SITE_KEY } : null,
    reportReasons: social.REPORT_REASONS,
  });
}

export async function getSettings(req: Request, res: Response) { ok(res, await settingsService.getSettings(uid(req))); }
export async function updateSettings(req: Request, res: Response) {
  ok(res, await settingsService.updateSettings(uid(req), settingsSchema.parse(req.body)));
}

export async function status(req: Request, res: Response) { ok(res, await mm.getStatus(uid(req))); }

export async function join(req: Request, res: Response) {
  const { captchaToken } = joinSchema.parse(req.body ?? {});
  ok(res, await mm.join(uid(req), { captchaToken, ip: req.ip }));
}
export async function leave(req: Request, res: Response) { ok(res, await mm.leave(uid(req))); }
export async function next(req: Request, res: Response) {
  const b = nextSchema.parse(req.body ?? {});
  ok(res, await mm.next(uid(req), { sessionId: b.sessionId, captchaToken: b.captchaToken, ip: req.ip }));
}

export async function getSession(req: Request, res: Response) { ok(res, await mm.sessionView(uid(req), req.params.id)); }
export async function endSession(req: Request, res: Response) { ok(res, await mm.endByUser(uid(req), req.params.id)); }

export async function messages(req: Request, res: Response) { ok(res, { messages: await chat.history(uid(req), req.params.id) }); }
export async function sendMessage(req: Request, res: Response) {
  const { content, clientId } = messageSchema.parse(req.body);
  const r = await chat.sendMessage(uid(req), req.params.id, content, clientId);
  if (!r.duplicate) chat.broadcastMessage(r.message, r.recipientId);
  ok(res, { id: r.message.id, createdAt: r.message.createdAt, duplicate: r.duplicate }, 201);
}

export async function profile(req: Request, res: Response) { ok(res, await social.viewPartnerProfile(uid(req), req.params.id)); }
export async function like(req: Request, res: Response) { ok(res, await social.likePartner(uid(req), req.params.id)); }
export async function block(req: Request, res: Response) { ok(res, await social.blockPartner(uid(req), req.params.id)); }
export async function report(req: Request, res: Response) {
  const { reason, description } = reportSchema.parse(req.body);
  ok(res, await social.reportPartner(uid(req), req.params.id, reason, description), 201);
}

export async function heartbeat(req: Request, res: Response) { await mm.heartbeat(uid(req)); ok(res, { t: Date.now() }); }
