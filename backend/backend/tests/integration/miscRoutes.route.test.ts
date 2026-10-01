// Chunk 15 — real route-level tests for the controllers still untested at
// this level: profile, block, report, swipe, notifications, and devices/push.
// Same approach as chunk 14's userRoutes.route.test.ts: mock
// `../../src/config/prisma` deeply, sign a real `accessToken` cookie with
// `signAccessToken` (JWT_ACCESS_SECRET is already configured by the shared
// test env), and drive everything else through the real Express app.
//
// swipe.service's match-creation transaction already has direct unit
// coverage in tests/unit/services/swipe.service.test.ts — the swipe route
// tests here are deliberately about the HTTP-boundary behavior (auth,
// validation, the notFound-not-403 anti-enumeration shape) plus one
// end-to-end "mutual like creates a match" pass through the real route,
// not a re-litigation of every branch the unit test already owns.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { mockDeep, mockReset, type DeepMockProxy } from "vitest-mock-extended";
import request from "supertest";

vi.mock("../../src/config/prisma", () => ({
  prisma: mockDeep<PrismaClient>(),
}));

vi.mock("../../src/services/push.service", () => ({
  sendPushToUser: vi.fn().mockResolvedValue(undefined),
  registerSubscription: vi.fn(),
  unregisterSubscription: vi.fn(),
  getPreferences: vi.fn(),
  updatePreferences: vi.fn(),
}));

import { app } from "../../src/app";
import { prisma } from "../../src/config/prisma";
import { signAccessToken } from "../../src/utils/tokens";
import * as pushService from "../../src/services/push.service";

const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;
const pushServiceMock = pushService as unknown as {
  registerSubscription: ReturnType<typeof vi.fn>;
  unregisterSubscription: ReturnType<typeof vi.fn>;
  getPreferences: ReturnType<typeof vi.fn>;
  updatePreferences: ReturnType<typeof vi.fn>;
};

const USER_ID = "user_1";
const SESSION_ID = "session_1";

function authed(method: "get" | "post" | "patch" | "delete", url: string) {
  const token = signAccessToken({ sub: USER_ID, sessionId: SESSION_ID });
  return request(app)
    [method](url)
    .set("Cookie", [`accessToken=${token}`]);
}

function mockValidSession() {
  prismaMock.session.findUnique.mockResolvedValue({
    id: SESSION_ID,
    revoked: false,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  } as any);
  prismaMock.user.findUnique.mockResolvedValue({ id: USER_ID, status: "ACTIVE" } as any);
}

beforeEach(() => {
  mockReset(prismaMock);
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("requireAuth guards every route group here the same way", () => {
  it.each([
    ["get", "/api/profile"],
    ["get", "/api/blocks"],
    ["post", "/api/reports"],
    ["post", "/api/swipes"],
    ["get", "/api/notifications"],
    ["get", "/api/devices/vapid-public-key"],
  ] as const)("%s %s returns 401 UNAUTHORIZED with no accessToken cookie at all", async (method, url) => {
    const res = await request(app)[method](url);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });
});

describe("GET/PATCH /api/profile", () => {
  it("GET /api/profile — 404 NOT_FOUND when no profile row exists yet, not an empty/default profile object", async () => {
    mockValidSession();
    prismaMock.profile.findUnique.mockResolvedValue(null);
    prismaMock.preference.findUnique.mockResolvedValue(null);
    prismaMock.userInterest.findMany.mockResolvedValue([]);

    const res = await authed("get", "/api/profile");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("GET /api/profile — returns the real shape, including hasLocation derived from stored coordinates (never the coordinates themselves)", async () => {
    mockValidSession();
    prismaMock.profile.findUnique.mockResolvedValue({
      displayName: "Asha",
      bio: "Hiker",
      education: null,
      occupation: null,
      languages: [],
      relationshipIntent: null,
      isDiscoverable: true,
      latitude: 12.9,
      longitude: 77.6,
    } as any);
    prismaMock.preference.findUnique.mockResolvedValue(null);
    prismaMock.userInterest.findMany.mockResolvedValue([]);

    const res = await authed("get", "/api/profile");
    expect(res.status).toBe(200);
    expect(res.body.data.profile.hasLocation).toBe(true);
    expect(res.body.data.profile).not.toHaveProperty("latitude");
    expect(res.body.data.profile).not.toHaveProperty("longitude");
  });

  it("PATCH /api/profile — 400 VALIDATION_ERROR on a bio over 500 chars, before ever touching the database", async () => {
    mockValidSession();
    const res = await authed("patch", "/api/profile").send({ bio: "x".repeat(501) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(prismaMock.profile.update).not.toHaveBeenCalled();
  });

  it("PATCH /api/profile/location — rejects an out-of-range latitude with 400 VALIDATION_ERROR", async () => {
    mockValidSession();
    const res = await authed("patch", "/api/profile/location").send({ latitude: 999, longitude: 0 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("PATCH /api/profile/preferences — the minAge<=maxAge refinement rejects an inverted range with 400 VALIDATION_ERROR", async () => {
    mockValidSession();
    const res = await authed("patch", "/api/profile/preferences").send({
      minAge: 40,
      maxAge: 25,
      maxDistanceKm: 50,
      genders: ["MALE"],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(prismaMock.preference.upsert).not.toHaveBeenCalled();
  });

  it("PATCH /api/profile/preferences — accepts a valid range and upserts it", async () => {
    mockValidSession();
    prismaMock.preference.upsert.mockResolvedValue({} as any);
    prismaMock.profile.findUnique.mockResolvedValue({ latitude: 1, longitude: 1 } as any);
    prismaMock.user.findUnique.mockResolvedValue({ id: USER_ID, status: "ACTIVE", verificationStatus: "VERIFIED" } as any);

    const res = await authed("patch", "/api/profile/preferences").send({
      minAge: 21,
      maxAge: 35,
      maxDistanceKm: 50,
      genders: ["MALE", "FEMALE"],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.updated).toBe(true);
    expect(prismaMock.preference.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: USER_ID },
        update: { minAge: 21, maxAge: 35, maxDistanceKm: 50, genders: ["MALE", "FEMALE"] },
      })
    );
  });
});

describe("blocks", () => {
  it("POST /api/blocks — 400 VALIDATION_ERROR when trying to block yourself, caught before the target-lookup query ever runs", async () => {
    mockValidSession();
    const res = await authed("post", "/api/blocks").send({ userId: USER_ID });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(prismaMock.user.findUnique).toHaveBeenCalledTimes(1); // requireAuth's lookup only
  });

  it("POST /api/blocks — 404 NOT_FOUND when the target user doesn't exist", async () => {
    mockValidSession();
    prismaMock.user.findUnique
      .mockResolvedValueOnce({ id: USER_ID, status: "ACTIVE" } as any) // requireAuth
      .mockResolvedValueOnce(null as any); // blockService's target lookup

    const res = await authed("post", "/api/blocks").send({ userId: "ghost_user" });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("POST /api/blocks — blocks a real user and also demotes any ACTIVE match between them to BLOCKED", async () => {
    mockValidSession();
    prismaMock.user.findUnique
      .mockResolvedValueOnce({ id: USER_ID, status: "ACTIVE" } as any)
      .mockResolvedValueOnce({ id: "target_user", status: "ACTIVE" } as any);
    prismaMock.block.upsert.mockResolvedValue({} as any);
    prismaMock.match.updateMany.mockResolvedValue({ count: 1 } as any);

    const res = await authed("post", "/api/blocks").send({ userId: "target_user" });
    expect(res.status).toBe(201);
    expect(res.body.data.blocked).toBe(true);
    expect(prismaMock.match.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "BLOCKED" } })
    );
  });

  it("GET /api/blocks — lists the caller's own blocked users", async () => {
    mockValidSession();
    prismaMock.block.findMany.mockResolvedValue([
      { blockedId: "u2", createdAt: new Date(), blocked: { profile: { displayName: "Sam" } } } as any,
    ]);

    const res = await authed("get", "/api/blocks");
    expect(res.status).toBe(200);
    expect(res.body.data.blocked).toEqual([
      { userId: "u2", name: "Sam", blockedAt: expect.any(String) },
    ]);
  });

  it("DELETE /api/blocks/:userId — unblocks", async () => {
    mockValidSession();
    prismaMock.block.deleteMany.mockResolvedValue({ count: 1 } as any);

    const res = await authed("delete", "/api/blocks/target_user");
    expect(res.status).toBe(200);
    expect(res.body.data.blocked).toBe(false);
  });
});

describe("POST /api/reports", () => {
  it("400 VALIDATION_ERROR on a reason under 3 chars", async () => {
    mockValidSession();
    const res = await authed("post", "/api/reports").send({
      reportedId: "u2",
      reason: "hi",
      targetType: "USER",
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("400 VALIDATION_ERROR when reporting yourself", async () => {
    mockValidSession();
    const res = await authed("post", "/api/reports").send({
      reportedId: USER_ID,
      reason: "Testing self-report",
      targetType: "USER",
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("creates a real report, always landing as OPEN regardless of what the client sends", async () => {
    mockValidSession();
    prismaMock.user.findUnique
      .mockResolvedValueOnce({ id: USER_ID, status: "ACTIVE" } as any)
      .mockResolvedValueOnce({ id: "target_user", status: "ACTIVE" } as any);
    prismaMock.report.create.mockResolvedValue({ id: "report_1", status: "OPEN" } as any);

    const res = await authed("post", "/api/reports").send({
      reportedId: "target_user",
      reason: "Inappropriate photos",
      targetType: "PHOTO",
      targetId: "photo_9",
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ reportId: "report_1", status: "OPEN" });
    expect(prismaMock.report.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "OPEN" }) })
    );
  });
});

describe("POST /api/swipes", () => {
  it("403 FORBIDDEN when identity verification is required and the caller isn't VERIFIED — never lets an unverified account swipe", async () => {
    mockValidSession();
    prismaMock.user.findUnique
      .mockResolvedValueOnce({ id: USER_ID, status: "ACTIVE" } as any) // requireAuth
      .mockResolvedValueOnce({ verificationStatus: "UNVERIFIED" } as any); // swipe.service's own check

    const res = await authed("post", "/api/swipes").send({ targetUserId: "u2", liked: true });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
    expect(prismaMock.swipe.create).not.toHaveBeenCalled();
  });

  it("409 ALREADY_SWIPED on a repeat swipe against the same target", async () => {
    mockValidSession();
    prismaMock.user.findUnique
      .mockResolvedValueOnce({ id: USER_ID, status: "ACTIVE" } as any)
      .mockResolvedValueOnce({ verificationStatus: "VERIFIED" } as any)
      .mockResolvedValueOnce({ id: "target_user", status: "ACTIVE" } as any);
    prismaMock.block.findUnique.mockResolvedValue(null);
    prismaMock.swipe.findUnique.mockResolvedValueOnce({ id: "existing_swipe" } as any);

    const res = await authed("post", "/api/swipes").send({ targetUserId: "target_user", liked: true });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("ALREADY_SWIPED");
  });

  it("a mutual like creates a real match + conversation end-to-end through the real route", async () => {
    mockValidSession();
    prismaMock.user.findUnique
      .mockResolvedValueOnce({ id: USER_ID, status: "ACTIVE" } as any) // requireAuth
      .mockResolvedValueOnce({ verificationStatus: "VERIFIED" } as any) // swipe.service's own check
      .mockResolvedValueOnce({ id: "target_user", status: "ACTIVE" } as any); // target lookup
    prismaMock.block.findUnique.mockResolvedValue(null);
    prismaMock.swipe.findUnique
      .mockResolvedValueOnce(null) // no existing swipe by actor on target
      .mockResolvedValueOnce({ liked: true } as any); // target already liked actor back
    prismaMock.swipe.create.mockResolvedValue({} as any);
    prismaMock.notification.create.mockResolvedValue({} as any);
    prismaMock.$transaction.mockImplementation(async (cb: any) => {
      const tx = {
        match: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: "match_1" }),
        },
        conversation: { create: vi.fn().mockResolvedValue({ id: "conv_1" }) },
        conversationMember: { createMany: vi.fn().mockResolvedValue({ count: 2 }) },
      };
      return cb(tx);
    });

    const res = await authed("post", "/api/swipes").send({ targetUserId: "target_user", liked: true });
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ liked: true, matched: true, matchId: "match_1", conversationId: "conv_1" });
  });
});

describe("notifications", () => {
  it("PATCH /api/notifications/:id/read — 404 NOT_FOUND when the id isn't the caller's own notification, never silently succeeds", async () => {
    mockValidSession();
    prismaMock.notification.updateMany.mockResolvedValue({ count: 0 } as any);

    const res = await authed("patch", "/api/notifications/notif_not_mine/read");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("PATCH /api/notifications/read-all — marks all unread as read", async () => {
    mockValidSession();
    prismaMock.notification.updateMany.mockResolvedValue({ count: 3 } as any);

    const res = await authed("patch", "/api/notifications/read-all");
    expect(res.status).toBe(200);
    expect(res.body.data.read).toBe(true);
    expect(prismaMock.notification.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: USER_ID, readAt: null }) })
    );
  });

  it("PATCH /api/notifications/preferences — an unknown notification type in the body is a 400 VALIDATION_ERROR, not silently accepted", async () => {
    mockValidSession();
    const res = await authed("patch", "/api/notifications/preferences").send({ disabledTypes: ["NOT_A_REAL_TYPE"] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("devices / push", () => {
  it("GET /api/devices/vapid-public-key — 503 CONFIGURATION_MISSING when VAPID isn't configured (the shared test-env default)", async () => {
    mockValidSession();
    const res = await authed("get", "/api/devices/vapid-public-key");
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("CONFIGURATION_MISSING");
  });

  it("POST /api/devices/push-subscription — 503 CONFIGURATION_MISSING when VAPID isn't configured, even with a well-formed subscription body", async () => {
    mockValidSession();
    const res = await authed("post", "/api/devices/push-subscription").send({
      subscription: {
        endpoint: "https://push.example.com/abc",
        keys: { p256dh: "key1", auth: "key2" },
      },
    });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("CONFIGURATION_MISSING");
    expect(pushServiceMock.registerSubscription).not.toHaveBeenCalled();
  });

  it("POST /api/devices/push-subscription — 400 VALIDATION_ERROR on a malformed endpoint URL, once push IS configured (registerSubscription checks configuration before validation, so this needs VAPID actually set to reach the real validation path)", async () => {
    vi.stubEnv("VAPID_PUBLIC_KEY", "test-public-key");
    vi.stubEnv("VAPID_PRIVATE_KEY", "test-private-key");
    vi.stubEnv("VAPID_SUBJECT", "mailto:support@matchify.test");
    vi.resetModules();

    const { app: freshApp } = await import("../../src/app");
    const { prisma: freshPrisma } = await import("../../src/config/prisma");
    const freshPrismaMock = freshPrisma as unknown as DeepMockProxy<PrismaClient>;
    mockReset(freshPrismaMock);
    const { signAccessToken: freshSign } = await import("../../src/utils/tokens");

    freshPrismaMock.session.findUnique.mockResolvedValue({
      id: SESSION_ID,
      revoked: false,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    } as any);
    freshPrismaMock.user.findUnique.mockResolvedValue({ id: USER_ID, status: "ACTIVE" } as any);

    const token = freshSign({ sub: USER_ID, sessionId: SESSION_ID });
    const res = await request(freshApp)
      .post("/api/devices/push-subscription")
      .set("Cookie", [`accessToken=${token}`])
      .send({ subscription: { endpoint: "not-a-url", keys: { p256dh: "key1", auth: "key2" } } });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("DELETE /api/devices/push-subscription — unregistering doesn't require push to be configured (a user can always remove a stale subscription)", async () => {
    mockValidSession();
    pushServiceMock.unregisterSubscription.mockResolvedValue(undefined);

    const res = await authed("delete", "/api/devices/push-subscription").send({
      endpoint: "https://push.example.com/abc",
    });
    expect(res.status).toBe(200);
    expect(res.body.data.registered).toBe(false);
    expect(pushServiceMock.unregisterSubscription).toHaveBeenCalledWith(USER_ID, "https://push.example.com/abc");
  });
});
