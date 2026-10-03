import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { env, appleOAuthConfigured } from "../config/env";
import { Errors } from "../utils/apiError";

export interface AppleIdentity {
  appleId: string;
  email: string;
  emailVerified: boolean;
}

interface Jwk { kid: string; kty: string; n: string; e: string; alg?: string; use?: string }
let cache: { keys: Jwk[]; fetchedAt: number } | null = null;

async function getKeys(force = false): Promise<Jwk[]> {
  if (!force && cache && Date.now() - cache.fetchedAt < 60 * 60 * 1000) return cache.keys;
  const res = await fetch("https://appleid.apple.com/auth/keys");
  if (!res.ok) throw new Error(`Apple keys request failed (${res.status})`);
  const data = (await res.json()) as { keys: Jwk[] };
  cache = { keys: data.keys, fetchedAt: Date.now() };
  return data.keys;
}

// Verifies the identity token Apple hands the browser (signature via Apple's
// published keys, issuer, audience = our Services ID, expiry).
export async function verifyAppleIdToken(idToken: string): Promise<AppleIdentity> {
  if (!appleOAuthConfigured) throw Errors.configurationMissing("Apple Sign-In (APPLE_CLIENT_ID)");

  const decoded = jwt.decode(idToken, { complete: true });
  const kid = decoded && typeof decoded === "object" ? decoded.header.kid : undefined;
  if (!kid) throw Errors.invalidToken();

  let key = (await getKeys()).find((k) => k.kid === kid);
  if (!key) key = (await getKeys(true)).find((k) => k.kid === kid);
  if (!key) throw Errors.invalidToken();

  let payload: jwt.JwtPayload;
  try {
    const publicKey = crypto.createPublicKey({ key: key as any, format: "jwk" });
    payload = jwt.verify(idToken, publicKey, {
      algorithms: ["RS256"],
      issuer: "https://appleid.apple.com",
      audience: env.APPLE_CLIENT_ID,
    }) as jwt.JwtPayload;
  } catch {
    throw Errors.invalidToken();
  }

  if (!payload.sub || !payload.email) throw Errors.invalidToken();
  return {
    appleId: String(payload.sub),
    email: String(payload.email).toLowerCase(),
    emailVerified: payload.email_verified === true || payload.email_verified === "true",
  };
}
