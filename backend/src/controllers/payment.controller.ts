import { Request, Response } from "express";
import { Errors } from "../utils/apiError";
import { verifyWebhookSignature } from "../utils/razorpaySignature";
import { env } from "../config/env";
import { checkoutSchema, verifyCheckoutSchema } from "../validators/payment.validator";
import * as paymentService from "../services/payment.service";

export async function checkout(req: Request, res: Response) {
  if (!req.userId) throw Errors.unauthorized();
  const { plan } = checkoutSchema.parse(req.body);
  const result = await paymentService.startCheckout(req.userId, plan);
  res.status(201).json({ success: true, data: result });
}

export async function verify(req: Request, res: Response) {
  if (!req.userId) throw Errors.unauthorized();
  const body = verifyCheckoutSchema.parse(req.body);
  const result = await paymentService.verifyCheckout(req.userId, {
    orderId: body.razorpay_order_id,
    paymentId: body.razorpay_payment_id,
    signature: body.razorpay_signature,
  });
  res.json({ success: true, data: result });
}

export async function history(req: Request, res: Response) {
  if (!req.userId) throw Errors.unauthorized();
  const payments = await paymentService.listPaymentHistory(req.userId);
  res.json({ success: true, data: { payments } });
}

// Not behind requireAuth — Razorpay calls this. Its authenticity comes
// entirely from the signature check, which is why (like the Stripe Identity
// webhook) this route is mounted in app.ts with express.raw() ahead of the
// global JSON parser: Razorpay's signature is computed over the exact raw
// bytes.
export async function webhook(req: Request, res: Response) {
  const signatureHeader = req.headers["x-razorpay-signature"];
  const rawBody = req.body as Buffer;

  verifyWebhookSignature(
    rawBody,
    typeof signatureHeader === "string" ? signatureHeader : undefined,
    env.RAZORPAY_WEBHOOK_SECRET
  );

  const event = JSON.parse(rawBody.toString("utf8"));
  await paymentService.handleWebhookEvent(rawBody, event);

  res.json({ success: true });
}
