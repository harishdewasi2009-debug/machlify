import { Request, Response } from "express";
import { Errors } from "../utils/apiError";
import { PLANS } from "../utils/plans";
import * as subscriptionService from "../services/subscription.service";

export async function getSubscription(req: Request, res: Response) {
  if (!req.userId) throw Errors.unauthorized();
  const entitlement = await subscriptionService.getEntitlement(req.userId);
  res.json({ success: true, data: entitlement });
}

export async function cancel(req: Request, res: Response) {
  if (!req.userId) throw Errors.unauthorized();
  const entitlement = await subscriptionService.cancelSubscription(req.userId);
  res.json({ success: true, data: entitlement });
}

// Lets the frontend render pricing without hardcoding amounts that could
// drift from what checkout actually charges.
export async function plans(_req: Request, res: Response) {
  res.json({ success: true, data: { plans: PLANS } });
}
