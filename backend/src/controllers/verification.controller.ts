import { Request, Response } from "express";
import { env } from "../config/env";
import { Errors } from "../utils/apiError";
import { verifyStripeSignature } from "../utils/stripeSignature";
import * as verificationService from "../services/verification.service";

export async function start(req: Request, res: Response) {
  if (!req.userId) throw Errors.unauthorized();
  const result = await verificationService.startVerification(req.userId);
  res.status(201).json({ success: true, data: result });
}

export async function submitSelfie(req: Request, res: Response) {
  if (!req.userId) throw Errors.unauthorized();
  if (!req.file) throw Errors.validation("No file uploaded. Send it as multipart/form-data field 'file'.");
  const result = await verificationService.submitSelfieVerification(req.userId, {
    buffer: req.file.buffer,
    size: req.file.size,
  });
  res.status(201).json({ success: true, data: result });
}

export async function status(req: Request, res: Response) {
  if (!req.userId) throw Errors.unauthorized();
  const result = await verificationService.getStatus(req.userId);
  res.json({ success: true, data: result });
}

// Not behind requireAuth — Stripe calls this, not a logged-in user. Its
// authenticity comes entirely from the signature check below, which is why
// this route is mounted (in app.ts) with express.raw() ahead of the global
// JSON body parser: the exact raw bytes are what the signature was computed
// over, and re-serializing a parsed-then-restringified body would not
// reliably match it.
export async function webhook(req: Request, res: Response) {
  const signatureHeader = req.headers["stripe-signature"];
  const rawBody = req.body as Buffer;

  verifyStripeSignature(
    rawBody,
    typeof signatureHeader === "string" ? signatureHeader : undefined,
    env.STRIPE_IDENTITY_WEBHOOK_SECRET
  );

  const event = JSON.parse(rawBody.toString("utf8"));
  await verificationService.handleWebhookEvent(event);

  res.json({ received: true });
}
