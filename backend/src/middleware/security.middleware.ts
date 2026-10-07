import { NextFunction, Request, Response } from "express";
import { allowedOrigins, isProduction } from "../config/env";
import { ApiError } from "../utils/apiError";

// Headers for the static pages (index.html / admin.html). helmet()'s full CSP can't be
// used on these pages because they contain inline scripts, so this adds the protections
// that DON'T break inline scripts: no framing (clickjacking — important for the admin
// panel), no <base>/<object> injection, forms only post to ourselves, no MIME sniffing.
export function staticPageSecurityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader(
    "Content-Security-Policy",
    "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'"
  );
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(self), microphone=(self), geolocation=(self)");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups"); // keeps Google/Apple sign-in popups working
  if (isProduction) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
}

// User-uploaded files are only ever images/audio. This stops the browser from ever
// executing or rendering anything in them as a page, even if a file were mislabeled.
export function uploadedFileHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
}

function originOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function isTrustedOrigin(origin: string, host: string | undefined): boolean {
  const o = origin.replace(/\/$/, "");
  if (allowedOrigins.includes(o)) return true;
  // The app serves its own frontend, so a page on this very host is always trusted.
  if (host) {
    try {
      if (new URL(o).host === host) return true;
    } catch {
      return false;
    }
  }
  return false;
}

// CSRF protection for cookie-authenticated requests. Auth cookies are SameSite=None in
// production (needed for a separately hosted frontend), so the browser WILL attach them to
// requests started by other websites. Browsers always send an Origin (or at least a Referer)
// header on cross-site state-changing requests, so any POST/PUT/PATCH/DELETE that names an
// origin we don't trust is rejected. Requests with neither header (curl, server-to-server,
// payment-provider webhooks) carry no ambient browser cookies, so they can't be CSRF.
export function csrfOriginGuard(req: Request, _res: Response, next: NextFunction) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();

  const origin = req.get("origin");
  const source = origin && origin !== "null" ? originOf(origin) : originOf(req.get("referer"));

  if (origin === "null" || (source === null && (origin || req.get("referer")))) {
    return next(new ApiError(403, "CSRF_BLOCKED", "Request origin could not be verified."));
  }
  if (source && !isTrustedOrigin(source, req.get("host"))) {
    return next(new ApiError(403, "CSRF_BLOCKED", "Request origin is not allowed."));
  }
  next();
}
