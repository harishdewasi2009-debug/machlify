import crypto from "node:crypto";
import { env, turnConfigured } from "../config/env";
import { Errors } from "./apiError";

export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

// Implements coturn's standard "REST API" time-limited credential scheme
// (https://github.com/coturn/coturn/blob/master/docs/turn-rest-api.md):
// username = "<expiryUnixSeconds>:<userId>", credential = base64(HMAC-SHA1(secret, username)).
// The TURN server is configured with the same shared secret and validates
// the HMAC itself — the backend never hands out a long-lived TURN password,
// and a credential minted for one user can't be replayed past its TTL.
export function generateTurnCredentials(userId: string): IceServer[] {
  if (!turnConfigured) throw Errors.configurationMissing("A TURN server");

  const expiry = Math.floor(Date.now() / 1000) + env.TURN_CREDENTIAL_TTL_SECONDS;
  const username = `${expiry}:${userId}`;
  const credential = crypto.createHmac("sha1", env.TURN_SECRET).update(username).digest("base64");

  const servers: IceServer[] = [];

  const stunUrls = env.STUN_URLS.split(",").map((u) => u.trim()).filter(Boolean);
  if (stunUrls.length > 0) servers.push({ urls: stunUrls });

  const turnUrls = env.TURN_URLS.split(",").map((u) => u.trim()).filter(Boolean);
  if (turnUrls.length > 0) servers.push({ urls: turnUrls, username, credential });

  return servers;
}
