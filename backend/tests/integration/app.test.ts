// Chunk 13, part 1 — real route-level tests against the actual `src/app.ts`
// with `supertest`, not a purpose-built stand-in app (that's what chunk 12's
// errorHandler tests use, deliberately, to avoid this file's heavier setup).
//
// Approach: mock `../../src/config/prisma` deeply (same pattern as every
// chunk-11/12 unit test) so every service/middleware call resolves without a
// real database, and mock the handful of external-provider service modules
// (email, Google, push, subscription) that would otherwise need their own
// env configuration. Everything else — routing, Express middleware order,
// zod validation at the HTTP boundary, rate limiting, cookie handling, and
// the raw-body webhook ordering — runs for real through the actual app.
//
// This file deliberately does NOT touch ADMIN_JWT_SECRET/admin-role gating —
// that needs the env module re-parsed with a real secret before `app.ts` is
// imported, which is a big enough difference in setup that it gets its own
// file: `tests/integration/adminAuth.route.test.ts`.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { mockDeep, mockReset, type DeepMockProxy } from "vitest-mock-extended";
import request from "supertest";

vi.mock("../../src/config/prisma", () => ({
  prisma: mockDeep<PrismaClient>(),
}));

// Real SMTP/Google/push/Razorpay/Stripe credentials are never set in the
// shared test env (see tests/setup.ts) — that's what makes the
// CONFIGURATION_MISSING assertions elsewhere meaningful. For the parts of
// this file that need a *successful* registration/login, the provider calls
// that would otherwise 503 are mocked at the service boundary instead of by
// configuring fake secrets, so the webhook tests later in this file still
// exercise a genuinely unconfigured path.
vi.mock("../../src/services/email.service", () => ({
  sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
  sendPasswordResetEmail: vi.fn().mockResolvedValue(undefined),
  sendAccountDeletionEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/services/google.service", () => ({
  verifyGoogleIdToken: vi.fn(),
}));

vi.mock("../../src/services/subscription.service", () => ({
  cancelSubscription: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/services/push.service", () => ({
  sendPushToUser: vi.fn().mockResolvedValue(undefined),
}));

import { app } from "../../src/app";
import { prisma } from "../../src/config/prisma";
import { hashPassword } from "../../src/utils/password";

const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;

beforeEach(() => {
  mockReset(prismaMock);
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /health", () => {
  it("responds without touching the database at all", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { status: "ok" } });
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
  });
});

describe("the /api/* 404 fallback", () => {
  it("returns the standard JSON error shape for an unknown /api route, not Express's default HTML 404", async () => {
    const res = await request(app).get("/api/this-route-does-not-exist");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error: { code: "NOT_FOUND", message: "Route not found." } });
  });

  it("still 404s for an unknown /api route under a different HTTP method", async () => {
    const res = await request(app).post("/api/also-not-a-route");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });
});

describe("POST /api/auth/register — validation at the HTTP boundary", () => {
  it("rejects a malformed body with 400 VALIDATION_ERROR before ever touching the database", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ name: "", email: "not-an-email", password: "short", dateOfBirth: "2020-01-01", gender: "F" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
  });

  it("returns 409 EMAIL_IN_USE when the email is already registered", async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: "existing_user" } as any);

    const res = await request(app).post("/api/auth/register").send({
      name: "Asha",
      email: "asha@example.com",
      password: "Str0ngPassw0rd",
      dateOfBirth: "1996-01-10",
      gender: "FEMALE",
    });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("EMAIL_IN_USE");
  });

  it("registers a real adult successfully end-to-end through the real route", async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    prismaMock.user.create.mockResolvedValue({ id: "user_1", email: "asha@example.com" } as any);
    prismaMock.emailVerificationToken.create.mockResolvedValue({} as any);

    const res = await request(app).post("/api/auth/register").send({
      name: "Asha",
      email: "asha@example.com",
      password: "Str0ngPassw0rd",
      dateOfBirth: "1996-01-10",
      gender: "FEMALE",
    });

    expect(res.status).toBe(201);
    expect(res.body.data.user).toEqual({ id: "user_1", email: "asha@example.com" });
    expect(prismaMock.user.create).toHaveBeenCalledTimes(1);
  });
});

describe("register/login rate limiting actually triggers across repeated requests", () => {
  // express-rate-limit's default store is in-memory per Express app instance,
  // so each of these gets its own freshly-imported app — otherwise register/
  // login calls made by earlier describe blocks above would silently count
  // against the same limiter and make the exact-count assertions below flaky
  // depending on test order.
  async function freshApp() {
    vi.resetModules();
    const mod = await import("../../src/app");
    const prismaMod = await import("../../src/config/prisma");
    const freshPrismaMock = prismaMod.prisma as unknown as DeepMockProxy<PrismaClient>;
    mockReset(freshPrismaMock);
    return { app: mod.app, prismaMock: freshPrismaMock };
  }

  it("returns 429 RATE_LIMITED on exactly the 6th /api/auth/register call within the window (limit is 5)", async () => {
    const { app: freshRegisterApp, prismaMock: freshPrismaMock } = await freshApp();
    freshPrismaMock.user.findUnique.mockResolvedValue({ id: "existing_user" } as any);

    const body = {
      name: "Asha",
      email: "asha@example.com",
      password: "Str0ngPassw0rd",
      dateOfBirth: "1996-01-10",
      gender: "FEMALE",
    };

    const responses = [];
    for (let i = 0; i < 6; i++) {
      responses.push(await request(freshRegisterApp).post("/api/auth/register").send(body));
    }

    responses.slice(0, 5).forEach((res) => expect(res.status).not.toBe(429));
    expect(responses[5].status).toBe(429);
    expect(responses[5].body).toEqual({
      success: false,
      error: { code: "RATE_LIMITED", message: "Too many registration attempts. Try again later." },
    });
  });

  it("returns 429 RATE_LIMITED on exactly the 11th /api/auth/login call within the window (limit is 10)", async () => {
    const { app: freshLoginApp, prismaMock: freshPrismaMock } = await freshApp();
    freshPrismaMock.user.findUnique.mockResolvedValue(null); // every attempt is "invalid credentials"

    const responses = [];
    for (let i = 0; i < 11; i++) {
      responses.push(
        await request(freshLoginApp).post("/api/auth/login").send({ email: "nobody@example.com", password: "whatever-1" })
      );
    }

    responses.slice(0, 10).forEach((res) => expect(res.status).not.toBe(429));
    expect(responses[10].status).toBe(429);
    expect(responses[10].body.error.code).toBe("RATE_LIMITED");
  });
});

describe("full session lifecycle through the real routes: login -> me -> refresh -> logout", () => {
  const PASSWORD = "Correct-Horse-1";

  it("walks the whole cookie-based session lifecycle end-to-end", async () => {
    const passwordHash = await hashPassword(PASSWORD);
    const agent = request.agent(app); // persists Set-Cookie across requests, like a real browser

    // --- 1. Unauthenticated /me is rejected, not crashed ---
    const unauthed = await agent.get("/api/auth/me");
    expect(unauthed.status).toBe(401);
    expect(unauthed.body.error.code).toBe("UNAUTHORIZED");

    // --- 2. Login ---
    prismaMock.user.findUnique.mockResolvedValue({
      id: "user_1",
      email: "asha@example.com",
      passwordHash,
      status: "ACTIVE",
      lockedUntil: null,
      failedLoginAttempts: 0,
      emailVerified: true,
    } as any);
    prismaMock.session.create.mockResolvedValue({ id: "session_1" } as any);
    prismaMock.refreshToken.create.mockResolvedValue({} as any);

    const login = await agent.post("/api/auth/login").send({ email: "asha@example.com", password: PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.data.user).toEqual({ id: "user_1", email: "asha@example.com", emailVerified: true });

    const setCookieHeader = login.headers["set-cookie"] as unknown as string[];
    expect(setCookieHeader.some((c) => c.startsWith("accessToken="))).toBe(true);
    const refreshCookie = setCookieHeader.find((c) => c.startsWith("refreshToken="));
    expect(refreshCookie).toBeDefined();
    // Scoped to the refresh path only — must never be sent on ordinary requests.
    expect(refreshCookie).toMatch(/Path=\/api\/auth\/refresh/i);

    // --- 3. requireAuth accepts the freshly-issued cookie on a protected route ---
    prismaMock.session.findUnique.mockResolvedValue({
      id: "session_1",
      revoked: false,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    } as any);

    const me = await agent.get("/api/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.data.userId).toBe("user_1");

    // --- 4. Refresh rotates the token and re-sets fresh cookies ---
    prismaMock.refreshToken.findUnique.mockResolvedValue({
      id: "rt_1",
      revoked: false,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      sessionId: "session_1",
      userId: "user_1",
    } as any);
    prismaMock.refreshToken.update.mockResolvedValue({} as any);

    const refresh = await agent.post("/api/auth/refresh");
    expect(refresh.status).toBe(200);
    expect(refresh.body.data.refreshed).toBe(true);
    expect(prismaMock.refreshToken.update).toHaveBeenCalled(); // old token rotated, not reused

    // --- 5. Logout revokes the session and clears cookies ---
    prismaMock.session.update.mockResolvedValue({} as any);
    const logout = await agent.post("/api/auth/logout");
    expect(logout.status).toBe(200);
    expect(logout.body.data.loggedOut).toBe(true);
    const logoutCookies = logout.headers["set-cookie"] as unknown as string[];
    // Cleared cookies carry an immediately-expired Max-Age/Expires.
    expect(logoutCookies.some((c) => /accessToken=;/.test(c) || /accessToken=$/.test(c))).toBe(true);
  });

  it("rejects login with a locked account even before checking the password", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: "user_1",
      email: "asha@example.com",
      passwordHash: await hashPassword(PASSWORD),
      status: "ACTIVE",
      lockedUntil: new Date(Date.now() + 60 * 60 * 1000),
      failedLoginAttempts: 5,
    } as any);

    const res = await request(app).post("/api/auth/login").send({ email: "asha@example.com", password: PASSWORD });
    expect(res.status).toBe(423);
    expect(res.body.error.code).toBe("ACCOUNT_LOCKED");
  });
});

describe("raw-body webhook routes are registered ahead of the global JSON parser", () => {
  // If express.json() ran first, a body that isn't valid JSON would blow up
  // inside the body-parser itself (a SyntaxError, which errorHandler renders
  // as a generic 500 INTERNAL_ERROR) before either webhook handler ever ran.
  // Getting a *webhook-specific* error back instead (503 CONFIGURATION_MISSING
  // here, since no webhook secret is configured in the shared test env) is
  // exactly what proves express.raw() is still mounted first for both of
  // these two routes, per chunk 12's "Not attempted here" note.

  it("POST /api/verification/webhook: a non-JSON raw body never reaches express.json()", async () => {
    const res = await request(app)
      .post("/api/verification/webhook")
      .set("Content-Type", "application/json")
      .send("this is not valid json {{{");

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("CONFIGURATION_MISSING");
  });

  it("POST /api/payments/webhook: a non-JSON raw body never reaches express.json()", async () => {
    const res = await request(app)
      .post("/api/payments/webhook")
      .set("Content-Type", "application/json")
      .send("also not json ]]]");

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("CONFIGURATION_MISSING");
  });

  it("control case: an ordinary JSON route DOES go through express.json(), and a parse failure there is a generic 500 that leaks nothing", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .set("Content-Type", "application/json")
      .send("{ not: valid json");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      success: false,
      error: { code: "INTERNAL_ERROR", message: "Something went wrong. Please try again." },
    });
    // Never touches auth logic at all — parsing failed before the route handler ran.
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
  });
});
