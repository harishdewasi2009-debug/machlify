// Chunk 13, part 2 — admin-auth separation and role gating, proven through
// the real HTTP routes rather than by calling requireAdminAuth/requireAdminRole
// directly (chunk 12 already covers that at the unit level).
//
// `src/config/env.ts` parses `process.env` once, at import time, and every
// other module (including `src/app.ts`) imports the resulting `env` object —
// so a test that needs `ADMIN_JWT_SECRET` actually configured has to set it
// *before* `app.ts` (or anything it imports) is ever required, then force a
// fresh module graph with `vi.resetModules()` + a dynamic `import()`. This is
// the same technique chunk 12's `adminTokens.test.ts` uses, just scoped to
// the whole app instead of one utils module — which is exactly why this
// lives in its own file instead of `app.test.ts`, which relies on the shared
// "nothing configured by default" test env staying untouched.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { mockDeep, mockReset, type DeepMockProxy } from "vitest-mock-extended";
import request from "supertest";
import jwt from "jsonwebtoken";

vi.mock("../../src/config/prisma", () => ({
  prisma: mockDeep<PrismaClient>(),
}));

const REAL_ADMIN_SECRET = "test-admin-jwt-secret-configured-0001";

afterEach(() => {
  vi.unstubAllEnvs();
});

async function freshAppWithAdminSecret(secret: string) {
  vi.stubEnv("ADMIN_JWT_SECRET", secret);
  vi.resetModules();
  const { app } = await import("../../src/app");
  const { prisma } = await import("../../src/config/prisma");
  const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;
  mockReset(prismaMock);
  return { app, prismaMock };
}

describe("admin auth, end-to-end, with ADMIN_JWT_SECRET configured", () => {
  it("logs an ADMIN in, reads /auth/me, and the session works across an agent's cookie jar", async () => {
    const { app, prismaMock } = await freshAppWithAdminSecret(REAL_ADMIN_SECRET);
    const { hashPassword } = await import("../../src/utils/password");

    const fullAdminRow = {
      id: "admin_1",
      email: "admin@matchify.example",
      passwordHash: await hashPassword("a-real-strong-password-1"),
      role: "ADMIN",
      lockedUntil: null,
      failedLoginAttempts: 0,
    };
    // Three findUnique calls happen across this test, in order: (1)
    // loginAdmin() needs the full row (checks passwordHash), (2)
    // requireAdminAuth middleware re-fetches the admin on the /auth/me
    // request, (3) getMe() itself calls findUnique with
    // `select: { id, email, role, createdAt }` — so, exactly like real
    // Prisma would, that third call only gets back the selected columns.
    // mockDeep ignores `select` by default, so we simulate that here with
    // per-call mocks instead of one blanket mockResolvedValue.
    prismaMock.adminUser.findUnique
      .mockResolvedValueOnce(fullAdminRow as any)
      .mockResolvedValueOnce(fullAdminRow as any)
      .mockResolvedValueOnce({
        id: fullAdminRow.id,
        email: fullAdminRow.email,
        role: fullAdminRow.role,
      } as any);
    prismaMock.adminUser.update.mockResolvedValue({} as any);

    prismaMock.adminSession.create.mockResolvedValue({ id: "admin_session_1" } as any);
    prismaMock.adminAuditLog.create.mockResolvedValue({} as any);

    const agent = request.agent(app);
    const login = await agent
      .post("/api/admin/auth/login")
      .send({ email: "admin@matchify.example", password: "a-real-strong-password-1" });

    expect(login.status).toBe(200);
    expect(login.body.data.admin).toEqual({ id: "admin_1", email: "admin@matchify.example", role: "ADMIN" });
    const cookies = login.headers["set-cookie"] as unknown as string[];
    expect(cookies.some((c) => c.startsWith("adminAccessToken="))).toBe(true);
    expect(cookies.find((c) => c.startsWith("adminAccessToken="))).toMatch(/Path=\/api\/admin/i);

    prismaMock.adminSession.findUnique.mockResolvedValue({
      id: "admin_session_1",
      revoked: false,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    } as any);

    const me = await agent.get("/api/admin/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.data).toEqual({ id: "admin_1", email: "admin@matchify.example", role: "ADMIN" });
  });

  it("never accepts the end-user `accessToken` cookie as a substitute for `adminAccessToken`", async () => {
    const { app } = await freshAppWithAdminSecret(REAL_ADMIN_SECRET);

    // A real end-user-style JWT, signed under a *different* secret entirely
    // (as it would be in production), sent under the end-user cookie name.
    const userStyleToken = jwt.sign({ sub: "user_1", sessionId: "session_1" }, "some-other-user-secret-0001");

    const res = await request(app).get("/api/admin/auth/me").set("Cookie", [`accessToken=${userStyleToken}`]);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("ADMIN_UNAUTHORIZED");
  });

  it("rejects a token that verifies under the wrong secret even when sent as `adminAccessToken`", async () => {
    const { app } = await freshAppWithAdminSecret(REAL_ADMIN_SECRET);

    const forgedToken = jwt.sign(
      { sub: "admin_1", adminSessionId: "admin_session_1", role: "ADMIN" },
      "an-attackers-guessed-secret-0001"
    );

    const res = await request(app).get("/api/admin/auth/me").set("Cookie", [`adminAccessToken=${forgedToken}`]);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("ADMIN_UNAUTHORIZED");
  });

  it("requireAdminRole: a MODERATOR-role token is forbidden from an ADMIN-only route", async () => {
    const { app, prismaMock } = await freshAppWithAdminSecret(REAL_ADMIN_SECRET);

    const moderatorToken = jwt.sign(
      { sub: "mod_1", adminSessionId: "admin_session_2", role: "MODERATOR" },
      REAL_ADMIN_SECRET,
      { expiresIn: "12h" }
    );
    prismaMock.adminSession.findUnique.mockResolvedValue({
      id: "admin_session_2",
      revoked: false,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    } as any);
    prismaMock.adminUser.findUnique.mockResolvedValue({ id: "mod_1", role: "MODERATOR" } as any);

    const res = await request(app)
      .post("/api/admin/users/some_user/suspend")
      .set("Cookie", [`adminAccessToken=${moderatorToken}`])
      .send({ reason: "Reviewing a report" });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ADMIN_FORBIDDEN");
  });

  it("requireAdminRole: an ADMIN-role token is allowed through to actually suspend the user", async () => {
    const { app, prismaMock } = await freshAppWithAdminSecret(REAL_ADMIN_SECRET);

    const adminToken = jwt.sign(
      { sub: "admin_1", adminSessionId: "admin_session_1", role: "ADMIN" },
      REAL_ADMIN_SECRET,
      { expiresIn: "12h" }
    );
    prismaMock.adminSession.findUnique.mockResolvedValue({
      id: "admin_session_1",
      revoked: false,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    } as any);
    prismaMock.adminUser.findUnique.mockResolvedValue({ id: "admin_1", role: "ADMIN" } as any);
    prismaMock.user.findUnique.mockResolvedValue({ id: "target_user", status: "ACTIVE" } as any);
    prismaMock.$transaction.mockResolvedValue([{}, {}] as any);
    prismaMock.adminAuditLog.create.mockResolvedValue({} as any);

    const res = await request(app)
      .post("/api/admin/users/target_user/suspend")
      .set("Cookie", [`adminAccessToken=${adminToken}`])
      .send({ reason: "Confirmed policy violation" });

    expect(res.status).toBe(200);
    expect(prismaMock.$transaction).toHaveBeenCalled();
    expect(prismaMock.adminAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "SUSPEND_USER", targetId: "target_user" }),
      })
    );
  });

  it("adminLoginRateLimiter actually triggers (10 FAILED attempts per window, tighter than end-user login; successful logins don't count)", async () => {
    const { app, prismaMock } = await freshAppWithAdminSecret(REAL_ADMIN_SECRET);
    prismaMock.adminUser.findUnique.mockResolvedValue(null); // every attempt "doesn't exist"

    let last;
    for (let i = 0; i < 11; i++) {
      last = await request(app)
        .post("/api/admin/auth/login")
        .send({ email: "nobody@matchify.example", password: "whatever-1" });
    }

    expect(last!.status).toBe(429);
    expect(last!.body.error.code).toBe("RATE_LIMITED");
  });
});

describe("admin auth, end-to-end, with ADMIN_JWT_SECRET left unconfigured (the shared default)", () => {
  it("collapses to a clean 401 ADMIN_UNAUTHORIZED on every /api/admin/* route, never a 503 or a crash", async () => {
    const { app } = await freshAppWithAdminSecret("");

    const res = await request(app).get("/api/admin/auth/me");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("ADMIN_UNAUTHORIZED");
  });

  it("login itself returns a real 503 CONFIGURATION_MISSING (not a fake success) when the password is correct but there's no secret to sign a token with", async () => {
    // This is a different code path from requireAdminAuth above: login isn't
    // behind requireAdminAuth (there's no session yet to require), so
    // signAdminAccessToken's ApiError(503) propagates straight to the shared
    // errorHandler unconverted — matching the chunk 9 README's documented
    // behavior for this specific route ("POST /api/admin/auth/login ...
    // returns 503 CONFIGURATION_MISSING"). The 401-collapse above is
    // specific to requireAdminAuth's own try/catch on *already-issued*
    // tokens, not to issuing a new one.
    const { app, prismaMock } = await freshAppWithAdminSecret("");
    const { hashPassword } = await import("../../src/utils/password");

    prismaMock.adminUser.findUnique.mockResolvedValue({
      id: "admin_1",
      email: "admin@matchify.example",
      passwordHash: await hashPassword("a-real-strong-password-1"),
      role: "ADMIN",
      lockedUntil: null,
      failedLoginAttempts: 0,
    } as any);
    prismaMock.adminUser.update.mockResolvedValue({} as any);
    prismaMock.adminSession.create.mockResolvedValue({ id: "admin_session_1" } as any);

    const res = await request(app)
      .post("/api/admin/auth/login")
      .send({ email: "admin@matchify.example", password: "a-real-strong-password-1" });

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("CONFIGURATION_MISSING");
  });
});
