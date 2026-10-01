import { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
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

  // Never leak stack traces, DB errors, or internal messages to the client.
  if (!isProduction) {
    // eslint-disable-next-line no-console
    console.error(err);
  }

  return res.status(500).json({
    success: false,
    error: { code: "INTERNAL_ERROR", message: "Something went wrong. Please try again." },
  });
}
