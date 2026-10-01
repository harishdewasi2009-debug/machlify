import { Request, Response } from "express";
import { paymentStatusQuerySchema, subscriptionStatusQuerySchema } from "../validators/admin.validator";
import * as adminPaymentsService from "../services/adminPayments.service";

export async function listPayments(req: Request, res: Response) {
  const { status, cursor } = paymentStatusQuerySchema.parse(req.query);
  const result = await adminPaymentsService.listPayments(status, cursor);
  res.json({ success: true, data: result });
}

export async function listSubscriptions(req: Request, res: Response) {
  const { status, cursor } = subscriptionStatusQuerySchema.parse(req.query);
  const result = await adminPaymentsService.listSubscriptions(status, cursor);
  res.json({ success: true, data: result });
}
