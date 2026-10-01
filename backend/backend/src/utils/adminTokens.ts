import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { Errors } from "./apiError";

export interface AdminAccessTokenPayload {
  sub: string; // adminUserId
  adminSessionId: string;
  role: string;
}

export function signAdminAccessToken(payload: AdminAccessTokenPayload): string {
  if (!env.ADMIN_JWT_SECRET) throw Errors.configurationMissing("Admin authentication");
  return jwt.sign(payload, env.ADMIN_JWT_SECRET, { expiresIn: `${env.ADMIN_SESSION_TTL_HOURS}h` });
}

export function verifyAdminAccessToken(token: string): AdminAccessTokenPayload {
  if (!env.ADMIN_JWT_SECRET) throw Errors.configurationMissing("Admin authentication");
  return jwt.verify(token, env.ADMIN_JWT_SECRET) as AdminAccessTokenPayload;
}
