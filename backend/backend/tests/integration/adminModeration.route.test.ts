// Chunk 14, part 2 — admin photo/verification moderation, the other half of
// chunk 13's "still not attempted" list. Reuses adminAuth.route.test.ts's own
// pattern exactly: ADMIN_JWT_SECRET has to be `vi.stubEnv`'d and the module
// graph reset *before* `src/app.ts` is imported, since `src/config/env.ts`
// parses `process.env` once at import time. requireAdminRole itself (role
// gating in general) is already covered there — this file is about the
// moderation *service* behavior these two routes exist for: never
// auto-approving, always writing an audit log, and cascading a primary-photo
// rejection to the next approved photo.
import { describe, it, expect, vi, afterEach } from "vitest";
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

function moderatorToken() {
  return jwt.sign(
    { sub: "mod_1", adminSessionId: "admin_session_1", role: "MODERATOR" },
    REAL_ADMIN_SECRET,
    { expiresIn: "12h" }
  );
}

function mockValidAdminSession(prismaMock: DeepMockProxy<PrismaClient>, role: "MODERATOR" | "ADMIN" = "MODERATOR") {
  prismaMock.adminSession.findUnique.mockResolvedValue({
    id: "admin_session_1",
    revoked: false,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  } as any);
  prismaMock.adminUser.findUnique.mockResolvedValue({ id: "mod_1", role } as any);
}

describe("GET /api/admin/photos — moderation queue", () => {
  it("401s with ADMIN_UNAUTHORIZED for a request with no admin cookie at all", async () => {
    const { app } = await freshAppWithAdminSecret(REAL_ADMIN_SECRET);
    const res = await request(app).get("/api/admin/photos");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("ADMIN_UNAUTHORIZED");
  });

  it("defaults to PENDING+MANUAL_REVIEW (the real review queue), not every photo ever uploaded", async () => {
    const { app, prismaMock } = await freshAppWithAdminSecret(REAL_ADMIN_SECRET);
    mockValidAdminSession(prismaMock);
    prismaMock.photo.findMany.mockResolvedValue([]);

    const res = await request(app).get("/api/admin/photos").set("Cookie", [`adminAccessToken=${moderatorToken()}`]);

    expect(res.status).toBe(200);
    expect(prismaMock.photo.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: { in: ["PENDING", "MANUAL_REVIEW"] } } })
    );
  });

  it("rejects an invalid ?status value with 400 VALIDATION_ERROR rather than silently ignoring it", async () => {
    const { app, prismaMock } = await freshAppWithAdminSecret(REAL_ADMIN_SECRET);
    mockValidAdminSession(prismaMock);

    const res = await request(app)
      .get("/api/admin/photos")
      .query({ status: "NOT_A_REAL_STATUS" })
      .set("Cookie", [`adminAccessToken=${moderatorToken()}`]);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("POST /api/admin/photos/:id/approve", () => {
  it("404s NOT_FOUND for a photo id that doesn't exist, without writing an audit log", async () => {
    const { app, prismaMock } = await freshAppWithAdminSecret(REAL_ADMIN_SECRET);
    mockValidAdminSession(prismaMock);
    prismaMock.photo.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post("/api/admin/photos/photo_ghost/approve")
      .set("Cookie", [`adminAccessToken=${moderatorToken()}`]);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
    expect(prismaMock.adminAuditLog.create).not.toHaveBeenCalled();
  });

  it("approves a real pending photo and records an audit log tied to the acting moderator", async () => {
    const { app, prismaMock } = await freshAppWithAdminSecret(REAL_ADMIN_SECRET);
    mockValidAdminSession(prismaMock);
    prismaMock.photo.findUnique.mockResolvedValue({ id: "photo_1", userId: "user_1", isPrimary: false } as any);
    prismaMock.photo.update.mockResolvedValue({} as any);
    prismaMock.adminAuditLog.create.mockResolvedValue({} as any);
    // approvePhoto also calls recomputeDiscoverability(userId), which reads
    // prisma.profile.findUnique first and returns early if that's falsy —
    // left unmocked here (mockDeep's unmocked default), so it's a real no-op
    // rather than something that needs its own elaborate setup.

    const res = await request(app)
      .post("/api/admin/photos/photo_1/approve")
      .set("Cookie", [`adminAccessToken=${moderatorToken()}`]);

    expect(res.status).toBe(200);
    expect(prismaMock.photo.update).toHaveBeenCalledWith({ where: { id: "photo_1" }, data: { status: "APPROVED" } });
    expect(prismaMock.adminAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ adminUserId: "mod_1", action: "APPROVE_PHOTO", targetId: "photo_1" }),
      })
    );
  });
});

describe("POST /api/admin/photos/:id/reject", () => {
  it("rejects a photo, promotes the next approved photo to primary when the rejected one was primary, and audit-logs the reason", async () => {
    const { app, prismaMock } = await freshAppWithAdminSecret(REAL_ADMIN_SECRET);
    mockValidAdminSession(prismaMock);
    prismaMock.photo.findUnique.mockResolvedValue({ id: "photo_1", userId: "user_1", isPrimary: true } as any);
    prismaMock.photo.update.mockResolvedValue({} as any);
    prismaMock.photo.findFirst.mockResolvedValue({ id: "photo_2" } as any); // the next approved photo
    prismaMock.adminAuditLog.create.mockResolvedValue({} as any);

    const res = await request(app)
      .post("/api/admin/photos/photo_1/reject")
      .set("Cookie", [`adminAccessToken=${moderatorToken()}`])
      .send({ reason: "Fails community guidelines" });

    expect(res.status).toBe(200);
    expect(prismaMock.photo.update).toHaveBeenCalledWith({ where: { id: "photo_1" }, data: { status: "REJECTED" } });
    // The cascade: photo_2 becomes the new primary.
    expect(prismaMock.photo.update).toHaveBeenCalledWith({ where: { id: "photo_2" }, data: { isPrimary: true } });
    expect(prismaMock.adminAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "REJECT_PHOTO",
          targetId: "photo_1",
          metadata: { reason: "Fails community guidelines" },
        }),
      })
    );
  });

  it("caps an over-length reason at 400 VALIDATION_ERROR (max 500 chars) before any database write", async () => {
    const { app, prismaMock } = await freshAppWithAdminSecret(REAL_ADMIN_SECRET);
    mockValidAdminSession(prismaMock);

    const res = await request(app)
      .post("/api/admin/photos/photo_1/reject")
      .set("Cookie", [`adminAccessToken=${moderatorToken()}`])
      .send({ reason: "x".repeat(501) });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(prismaMock.photo.findUnique).not.toHaveBeenCalled();
  });
});

describe("verification review — never marks VERIFIED except through this audited path", () => {
  it("GET /api/admin/verifications defaults to the real pending queue (MANUAL_REVIEW/PENDING/PROCESSING)", async () => {
    const { app, prismaMock } = await freshAppWithAdminSecret(REAL_ADMIN_SECRET);
    mockValidAdminSession(prismaMock);
    prismaMock.verificationSession.findMany.mockResolvedValue([]);

    const res = await request(app)
      .get("/api/admin/verifications")
      .set("Cookie", [`adminAccessToken=${moderatorToken()}`]);

    expect(res.status).toBe(200);
    expect(prismaMock.verificationSession.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: { in: ["MANUAL_REVIEW", "PENDING", "PROCESSING"] } } })
    );
  });

  it("POST /api/admin/verifications/:id/approve — 404s for an unknown session, never fabricates a VERIFIED user", async () => {
    const { app, prismaMock } = await freshAppWithAdminSecret(REAL_ADMIN_SECRET);
    mockValidAdminSession(prismaMock);
    prismaMock.verificationSession.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post("/api/admin/verifications/session_ghost/approve")
      .set("Cookie", [`adminAccessToken=${moderatorToken()}`]);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("approves a real session through one atomic transaction covering the session, the user's verificationStatus, and the event log — plus its own audit log", async () => {
    const { app, prismaMock } = await freshAppWithAdminSecret(REAL_ADMIN_SECRET);
    mockValidAdminSession(prismaMock);
    prismaMock.verificationSession.findUnique.mockResolvedValue({ id: "vs_1", userId: "user_1" } as any);
    prismaMock.$transaction.mockResolvedValue([{}, {}, {}] as any);
    prismaMock.adminAuditLog.create.mockResolvedValue({} as any);

    const res = await request(app)
      .post("/api/admin/verifications/vs_1/approve")
      .set("Cookie", [`adminAccessToken=${moderatorToken()}`]);

    expect(res.status).toBe(200);
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(prismaMock.adminAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "APPROVE_VERIFICATION", targetId: "vs_1" }),
      })
    );
  });

  it("rejects a real session with a reason, through the same transactional path", async () => {
    const { app, prismaMock } = await freshAppWithAdminSecret(REAL_ADMIN_SECRET);
    mockValidAdminSession(prismaMock);
    prismaMock.verificationSession.findUnique.mockResolvedValue({ id: "vs_1", userId: "user_1" } as any);
    prismaMock.$transaction.mockResolvedValue([{}, {}, {}] as any);
    prismaMock.adminAuditLog.create.mockResolvedValue({} as any);

    const res = await request(app)
      .post("/api/admin/verifications/vs_1/reject")
      .set("Cookie", [`adminAccessToken=${moderatorToken()}`])
      .send({ reason: "Document didn't match selfie" });

    expect(res.status).toBe(200);
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(prismaMock.adminAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "REJECT_VERIFICATION",
          targetId: "vs_1",
          metadata: { reason: "Document didn't match selfie" },
        }),
      })
    );
  });
});
