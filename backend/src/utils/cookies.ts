import { Response } from "express";
import { env, isProduction } from "../config/env";

const baseCookieOptions = {
  httpOnly: true,
  secure: isProduction, // HTTPS-only in production
  sameSite: "lax" as const,
  domain: isProduction ? env.COOKIE_DOMAIN : undefined,
};

export function setAuthCookies(res: Response, accessToken: string, refreshToken: string) {
  res.cookie("accessToken", accessToken, {
    ...baseCookieOptions,
    maxAge: env.ACCESS_TOKEN_TTL_MIN * 60 * 1000,
  });
  res.cookie("refreshToken", refreshToken, {
    ...baseCookieOptions,
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
    path: "/api/auth/refresh",
  });
}

export function clearAuthCookies(res: Response) {
  res.clearCookie("accessToken", baseCookieOptions);
  res.clearCookie("refreshToken", { ...baseCookieOptions, path: "/api/auth/refresh" });
}

// Separate cookie name and path from the end-user auth cookies above — an
// admin token must never be sent on ordinary /api/* requests (or vice
// versa), which scoping the path to /api/admin enforces at the browser
// level in addition to the two token types using different JWT secrets.
export function setAdminAuthCookie(res: Response, adminAccessToken: string) {
  res.cookie("adminAccessToken", adminAccessToken, {
    ...baseCookieOptions,
    path: "/api/admin",
    maxAge: env.ADMIN_SESSION_TTL_HOURS * 60 * 60 * 1000,
  });
}

export function clearAdminAuthCookie(res: Response) {
  res.clearCookie("adminAccessToken", { ...baseCookieOptions, path: "/api/admin" });
}
