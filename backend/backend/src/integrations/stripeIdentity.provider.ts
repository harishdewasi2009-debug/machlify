import { env, verificationConfigured } from "../config/env";
import { Errors } from "../utils/apiError";

const STRIPE_API_BASE = "https://api.stripe.com/v1";

export interface StripeVerificationSession {
  id: string;
  status: string;
  url?: string;
  client_secret?: string;
  last_error?: { code?: string; reason?: string } | null;
}

interface StripeErrorBody {
  error?: { message?: string };
}

async function stripeRequest<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${STRIPE_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
      ...init.headers,
    },
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as StripeErrorBody;
    throw new Error(`Stripe Identity error (HTTP ${response.status}): ${body.error?.message ?? "unknown"}`);
  }

  return response.json() as Promise<T>;
}

// Creates a hosted Stripe Identity verification session for a user. The
// return_url is where Stripe redirects the user's browser back to after
// they finish the provider-hosted flow; the actual verdict always arrives
// asynchronously via the webhook, never trusted from that redirect alone.
export async function createVerificationSession(userId: string, returnUrl: string): Promise<StripeVerificationSession> {
  if (!verificationConfigured) throw Errors.configurationMissing("Identity verification");

  const body = new URLSearchParams({
    type: "document",
    "metadata[userId]": userId,
    "options[document][require_matching_selfie]": "true",
    return_url: returnUrl,
  });

  return stripeRequest<StripeVerificationSession>("/identity/verification_sessions", {
    method: "POST",
    body,
  });
}

export async function retrieveVerificationSession(providerSessionId: string): Promise<StripeVerificationSession> {
  if (!verificationConfigured) throw Errors.configurationMissing("Identity verification");
  return stripeRequest<StripeVerificationSession>(`/identity/verification_sessions/${providerSessionId}`, {
    method: "GET",
  });
}
