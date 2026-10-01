import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { z } from "zod";
import { errorHandler } from "../../../src/middleware/errorHandler.middleware";
import { Errors } from "../../../src/utils/apiError";
import { asyncHandler } from "../../../src/utils/asyncHandler";

// A minimal app wired with just the real errorHandler, rather than importing
// the full src/app.ts — that pulls in every controller (multer, sharp,
// razorpay, stripe, socket.io, ...) for no benefit here, since what's under
// test is only "does a thrown error become the right HTTP response".
function buildTestApp() {
  const app = express();
  app.use(express.json());

  app.get("/api-error", (_req, _res, next) => next(Errors.notFound("Payment")));

  app.post("/zod-error", (req, _res, next) => {
    try {
      z.object({ email: z.string().email() }).parse(req.body);
      next();
    } catch (err) {
      next(err);
    }
  });

  app.get("/boom", () => {
    throw new Error("leaked internal detail: connection string is postgres://user:pass@host/db");
  });

  app.get(
    "/async-boom",
    asyncHandler(async () => {
      throw Errors.forbidden("Nope.");
    })
  );

  app.use(errorHandler);
  return app;
}

describe("errorHandler — HTTP response shape", () => {
  const app = buildTestApp();

  it("renders an ApiError as { success: false, error: { code, message } } with its own status code", async () => {
    const res = await request(app).get("/api-error");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error: { code: "NOT_FOUND", message: "Payment not found." } });
  });

  it("renders a ZodError as a 400 VALIDATION_ERROR", async () => {
    const res = await request(app).post("/zod-error").send({ email: "not-an-email" });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("renders an unknown thrown Error as a generic 500 that never echoes the original message", async () => {
    const res = await request(app).get("/boom");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      success: false,
      error: { code: "INTERNAL_ERROR", message: "Something went wrong. Please try again." },
    });
    // The whole point of the generic message: nothing from the real error
    // (a connection string, in this deliberately nasty example) reaches the client.
    expect(JSON.stringify(res.body)).not.toMatch(/postgres:\/\//);
  });

  it("asyncHandler forwards a rejected promise into the same error pipeline", async () => {
    const res = await request(app).get("/async-boom");
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });
});
