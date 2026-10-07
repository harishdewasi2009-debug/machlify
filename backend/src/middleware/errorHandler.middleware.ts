import { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import multer from "multer";
import { ApiError } from "../utils/apiError";
import { isProduction } from "../config/env";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ApiError) {
    return res.status(err.statusCode).json({
      success: false,
      error: { code: err.code, message: err.message },
    });
  }

  if (err instanceof ZodError) {
    return res.status(400).json({
      success: false,
      error: { code: "VALIDATION_ERROR", message: err.errors[0]?.message ?? "Invalid request." },
    });
  }

  // Upload problems (file too large, unexpected field) are the client's fault, not a 500.
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ success: false, error: { code: "UPLOAD_ERROR", message: err.message } });
  }

  // Malformed / oversized JSON bodies surface from body-parser as errors with a 4xx status.
  const status = (err as { status?: number; statusCode?: number } | null)?.status ?? (err as { statusCode?: number } | null)?.statusCode;
  if (typeof status === "number" && status >= 400 && status < 500 && (err as { type?: string }).type?.startsWith("entity.")) {
    return res.status(status).json({
      success: false,
      error: { code: status === 413 ? "PAYLOAD_TOO_LARGE" : "BAD_REQUEST", message: status === 413 ? "Request body is too large." : "Malformed request body." },
    });
  }

  // Never leak stack traces, DB errors, or internal messages to the client.
  // Always log server-side (the client only sees a generic message). Without this, production 500s are invisible.
  // eslint-disable-next-line no-console
  console.error("[error]", isProduction ? (err instanceof Error ? `${err.name}: ${err.message}` : err) : err);

  return res.status(500).json({
    success: false,
    error: { code: "INTERNAL_ERROR", message: "Something went wrong. Please try again." },
  });
}
