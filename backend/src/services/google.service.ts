import { OAuth2Client } from "google-auth-library";
import { env, googleOAuthConfigured } from "../config/env";
import { Errors } from "../utils/apiError";

const client = googleOAuthConfigured ? new OAuth2Client(env.GOOGLE_CLIENT_ID) : null;

export interface GoogleIdentity {
  googleId: string;
  email: string;
  emailVerified: boolean;
}

// The frontend hands us a Google-issued ID token, never a bare email. We
// verify its signature and audience directly with Google's library — this
// is what stops someone from POSTing an arbitrary "email" and claiming it's
// verified by Google.
export async function verifyGoogleIdToken(idToken: string): Promise<GoogleIdentity> {
  if (!client) {
    throw Errors.configurationMissing("Google OAuth");
  }

  const ticket = await client.verifyIdToken({
    idToken,
    audience: env.GOOGLE_CLIENT_ID,
  });

  const payload = ticket.getPayload();
  if (!payload || !payload.sub || !payload.email) {
    throw Errors.invalidToken();
  }

  return {
    googleId: payload.sub,
    email: payload.email.toLowerCase(),
    emailVerified: Boolean(payload.email_verified),
  };
}
