import { env, razorpayConfigured } from "../config/env";
import { Errors } from "../utils/apiError";

interface RazorpayOrder {
  id: string;
  amount: number;
  currency: string;
  status: string;
}

function authHeader(): string {
  const token = Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString("base64");
  return `Basic ${token}`;
}

// Real call to Razorpay's Orders API — https://razorpay.com/docs/api/orders/create
// No SDK dependency, same raw-fetch style used for Sightengine/Stripe.
export async function createOrder(params: {
  amount: number;
  currency: string;
  receipt: string;
  notes?: Record<string, string>;
}): Promise<RazorpayOrder> {
  if (!razorpayConfigured) {
    throw Errors.configurationMissing("Payments");
  }

  const response = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      amount: params.amount,
      currency: params.currency,
      receipt: params.receipt,
      notes: params.notes ?? {},
    }),
  });

  const data = (await response.json()) as RazorpayOrder & { error?: { description?: string } };

  if (!response.ok || data.error) {
    throw new Error(`Razorpay order creation failed: ${data.error?.description ?? response.status}`);
  }

  return data;
}

// Used only as a defensive cross-check in the webhook handler (fetching the
// payment directly from Razorpay rather than trusting the webhook payload
// alone) when the webhook secret isn't configured yet but keys are — see
// payment.service.handleWebhookEvent.
export async function fetchPayment(paymentId: string): Promise<{ id: string; order_id: string; status: string }> {
  if (!razorpayConfigured) {
    throw Errors.configurationMissing("Payments");
  }

  const response = await fetch(`https://api.razorpay.com/v1/payments/${paymentId}`, {
    headers: { Authorization: authHeader() },
  });

  const data = (await response.json()) as { id: string; order_id: string; status: string; error?: { description?: string } };

  if (!response.ok || data.error) {
    throw new Error(`Razorpay payment lookup failed: ${data.error?.description ?? response.status}`);
  }

  return data;
}
