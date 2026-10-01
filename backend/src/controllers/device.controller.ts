import { Request, Response } from "express";
import { Errors } from "../utils/apiError";
import { env, pushConfigured } from "../config/env";
import {
  registerPushSubscriptionSchema,
  unregisterPushSubscriptionSchema,
} from "../validators/push.validator";
import * as pushService from "../services/push.service";

export async function vapidPublicKey(_req: Request, res: Response) {
  if (!pushConfigured) throw Errors.configurationMissing("Push notifications");
  res.json({ success: true, data: { publicKey: env.VAPID_PUBLIC_KEY } });
}

export async function registerSubscription(req: Request, res: Response) {
  if (!req.userId) throw Errors.unauthorized();
  if (!pushConfigured) throw Errors.configurationMissing("Push notifications");
  const { subscription, platform } = registerPushSubscriptionSchema.parse(req.body);
  await pushService.registerSubscription(req.userId, subscription, platform);
  res.status(201).json({ success: true, data: { registered: true } });
}

export async function unregisterSubscription(req: Request, res: Response) {
  if (!req.userId) throw Errors.unauthorized();
  const { endpoint } = unregisterPushSubscriptionSchema.parse(req.body);
  await pushService.unregisterSubscription(req.userId, endpoint);
  res.json({ success: true, data: { registered: false } });
}
