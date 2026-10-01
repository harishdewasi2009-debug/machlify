// Chunk 14, part 1 — real route-level tests against the actual `src/app.ts`
// for the controllers chunk 13's coverage note flagged as untouched: photos,
// discovery, matches, chat/conversations, and calls. Same approach as
// `app.test.ts`: mock `../../src/config/prisma` deeply and drive everything
// else — routing, requireAuth, zod validation, object-level authorization —
// through the real Express app with `supertest`.
//
// requireAuth reads a real, `verifyAccessToken`-signed `accessToken` cookie
// (JWT_ACCESS_SECRET is already configured by the shared test env in
// tests/setup.ts, unlike ADMIN_JWT_SECRET), so authenticated requests here
// sign one directly with `signAccessToken` instead of going through a live
// `/api/auth/login` call — `app.test.ts`'s "full session lifecycle" describe
// block already covers that path end-to-end.
//
// Photo upload additionally needs object storage and moderation "configured"
// to reach a real APPROVED/success outcome. Rather than stub S3/Sightengine
// env vars and hit real networks, `storage.service` and `moderation.service`
// are mocked at the module boundary (same pattern as `email.service` /
// `google.service` in app.test.ts) so the *storage-not-configured* 503 test
// stays meaningful as the true default-env behavior, while the success-path
// test exercises the real route, real multipart parsing, and real image
// decoding (`image.service` is NOT mocked — a real 1x1-scaled-up JPEG is
// generated with `sharp` and actually uploaded and decoded).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { mockDeep, mockReset, type DeepMockProxy } from "vitest-mock-extended";
import request from "supertest";
import sharp from "sharp";

vi.mock("../../src/config/prisma", () => ({
  prisma: mockDeep<PrismaClient>(),
}));

vi.mock("../../src/services/storage.service", () => ({
  putObject: vi.fn().mockResolvedValue(undefined),
  deleteObject: vi.fn().mockResolvedValue(undefined),
  getObjectUrl: vi.fn().mockImplementation(async (key: string) => `https://cdn.matchify.test/${key}`),
  buildPhotoKey: vi.fn(
    (userId: string, photoId: string, variant: string) => `users/${userId}/photos/${photoId}/${variant}`
  ),
}));

vi.mock("../../src/services/moderation.service", () => ({
  moderateImage: vi.fn().mockResolvedValue({ status: "APPROVED", scores: { sexualActivity: 0 } }),
}));

vi.mock("../../src/services/push.service", () => ({
  sendPushToUser: vi.fn().mockResolvedValue(undefined),
}));

import { app } from "../../src/app";
import { prisma } from "../../src/config/prisma";
import { signAccessToken } from "../../src/utils/tokens";
import { putObject } from "../../src/services/storage.service";

const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;

const USER_ID = "user_1";
const SESSION_ID = "session_1";

// A minimal, but genuinely decodable, 400x400 JPEG — big enough to clear
// image.service's MIN_DIMENSION (200px) floor.
async function realJpegBuffer(): Promise<Buffer> {
  return sharp({ create: { width: 400, height: 400, channels: 3, background: { r: 120, g: 80, b: 200 } } })
    .jpeg()
    .toBuffer();
}

// requireAuth only reads the `accessToken` cookie, so a plain per-request
// `.set("Cookie", ...)` (the same technique adminAuth.route.test.ts uses for
// its own client-minted tokens) is all that's needed here — no supertest
// agent/cookie-jar plumbing required since nothing in this file relies on a
// server-issued Set-Cookie surviving across multiple requests.
function authedAgent() {
  const token = signAccessToken({ sub: USER_ID, sessionId: SESSION_ID });
  return {
    get: (url: string) => request(app).get(url).set("Cookie", [`accessToken=${token}`]),
    post: (url: string) => request(app).post(url).set("Cookie", [`accessToken=${token}`]),
    patch: (url: string) => request(app).patch(url).set("Cookie", [`accessToken=${token}`]),
    delete: (url: string) => request(app).delete(url).set("Cookie", [`accessToken=${token}`]),
  };
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
    ["GET", "/api/photos"],
    ["GET", "/api/discovery"],
    ["GET", "/api/matches"],
    ["GET", "/api/conversations"],
    ["GET", "/api/calls/history"],
  ])("%s %s returns 401 UNAUTHORIZED with no accessToken cookie at all", async (method, url) => {
    const res = await (request(app) as any)[method.toLowerCase()](url);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });
});

describe("POST /api/photos — real multipart upload through the real route", () => {
  it("returns 503 CONFIGURATION_MISSING when object storage isn't configured (the shared test-env default) — never a fake success", async () => {
    mockValidSession();
    const buf = await realJpegBuffer();

    const res = await authedAgent().post("/api/photos").attach("file", buf, "photo.jpg");

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("CONFIGURATION_MISSING");
    expect(putObject).not.toHaveBeenCalled();
  });

  it("rejects with 400 VALIDATION_ERROR when no file field is attached at all", async () => {
    mockValidSession();
    const res = await authedAgent().post("/api/photos").field("notAFile", "oops");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("uploads, moderates, stores, and returns an APPROVED photo end-to-end when storage+moderation are configured", async () => {
    vi.stubEnv("S3_ACCESS_KEY", "test-key");
    vi.stubEnv("S3_SECRET_KEY", "test-secret");
    vi.stubEnv("S3_BUCKET", "matchify-test-bucket");
    vi.resetModules();

    const { app: freshApp } = await import("../../src/app");
    const { prisma: freshPrisma } = await import("../../src/config/prisma");
    const freshPrismaMock = freshPrisma as unknown as DeepMockProxy<PrismaClient>;
    mockReset(freshPrismaMock);
    const { signAccessToken: freshSign } = await import("../../src/utils/tokens");
    // vi.resetModules() clears the module cache, so the mocked
    // storage/moderation modules are re-instantiated too — the top-level
    // `putObject`/`moderateImage` imports above are now stale references
    // pointing at a discarded module instance. Re-import them fresh so
    // assertions below check the actual functions the reset app's
    // photo.service is calling through.
    const { putObject: freshPutObject } = await import("../../src/services/storage.service");
    const { moderateImage: freshModerateImage } = await import("../../src/services/moderation.service");

    freshPrismaMock.session.findUnique.mockResolvedValue({
      id: SESSION_ID,
      revoked: false,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    } as any);
    freshPrismaMock.user.findUnique.mockResolvedValue({ id: USER_ID, status: "ACTIVE" } as any);
    freshPrismaMock.photo.count.mockResolvedValue(0);
    freshPrismaMock.photo.findFirst.mockResolvedValue(null); // no own-duplicate, no reused-elsewhere match
    freshPrismaMock.photo.create.mockResolvedValue({
      id: "photo_1",
      status: "APPROVED",
      isPrimary: true,
      position: 0,
      createdAt: new Date(),
      thumbnailKey: "users/user_1/photos/photo_1/thumbnail",
      mediumKey: "users/user_1/photos/photo_1/medium",
      largeKey: "users/user_1/photos/photo_1/large",
    } as any);

    const token = freshSign({ sub: USER_ID, sessionId: SESSION_ID });
    const buf = await realJpegBuffer();

    const res = await request(freshApp)
      .post("/api/photos")
      .set("Cookie", [`accessToken=${token}`])
      .attach("file", buf, "photo.jpg");

    expect(res.status).toBe(201);
    expect(res.body.data.photo.status).toBe("APPROVED");
    expect(res.body.data.photo.urls.thumbnail).toContain("users/user_1/photos/photo_1/thumbnail");
    expect(freshModerateImage).toHaveBeenCalledTimes(1);
    expect(freshPutObject).toHaveBeenCalledTimes(4); // original + large + medium + thumbnail
    expect(freshPrismaMock.photo.create).toHaveBeenCalledTimes(1);
  });
});

describe("photo ownership — object-level authorization on reorder/primary/delete", () => {
  it("PATCH /api/photos/:id/primary — 404 NOT_FOUND when the photo belongs to a different user, not a 403 that would confirm it exists", async () => {
    mockValidSession();
    prismaMock.photo.findUnique.mockResolvedValue({ id: "photo_9", userId: "someone_else" } as any);

    const res = await authedAgent().patch("/api/photos/photo_9/primary");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("PATCH /api/photos/reorder — 400 VALIDATION_ERROR when a photo id in the list isn't the caller's own", async () => {
    mockValidSession();
    prismaMock.photo.count.mockResolvedValue(1); // only 1 of 2 requested ids is actually owned

    const res = await authedAgent().patch("/api/photos/reorder").send({ order: ["photo_mine", "photo_not_mine"] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("DELETE /api/photos/:id succeeds for the owner and cleans up storage", async () => {
    mockValidSession();
    prismaMock.photo.findUnique.mockResolvedValue({
      id: "photo_1",
      userId: USER_ID,
      isPrimary: false,
      storageKey: "k/original",
      largeKey: "k/large",
      mediumKey: "k/medium",
      thumbnailKey: "k/thumb",
    } as any);
    prismaMock.photo.delete.mockResolvedValue({} as any);

    const res = await authedAgent().delete("/api/photos/photo_1");
    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toBe(true);
    expect(prismaMock.photo.delete).toHaveBeenCalledWith({ where: { id: "photo_1" } });
  });
});

describe("GET /api/discovery", () => {
  it("400s with a real, specific validation message when profile/location/preferences aren't set up yet — never returns an empty feed as if that were normal", async () => {
    mockValidSession();
    prismaMock.user.findUnique.mockResolvedValueOnce({ id: USER_ID, status: "ACTIVE" } as any); // requireAuth
    prismaMock.user.findUnique.mockResolvedValueOnce({ id: USER_ID, profile: null, preferences: null } as any); // discovery.service

    const res = await authedAgent().get("/api/discovery");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("403s with FORBIDDEN when identity verification is required (the default) and the user isn't VERIFIED, before ever running the candidate query", async () => {
    mockValidSession();
    prismaMock.user.findUnique.mockResolvedValueOnce({ id: USER_ID, status: "ACTIVE" } as any); // requireAuth
    prismaMock.user.findUnique.mockResolvedValueOnce({
      id: USER_ID,
      verificationStatus: "UNVERIFIED",
      dateOfBirth: new Date("1995-01-01"),
      gender: "FEMALE",
      profile: { latitude: 12.9, longitude: 77.6 },
      preferences: { minAge: 21, maxAge: 35, maxDistanceKm: 50, genders: ["MALE"] },
    } as any);

    const res = await authedAgent().get("/api/discovery");
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
    expect(prismaMock.user.findMany).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range query param (limit > 50) with 400 VALIDATION_ERROR at the HTTP boundary", async () => {
    mockValidSession();
    const res = await authedAgent().get("/api/discovery").query({ limit: 999 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("GET /api/matches and DELETE /api/matches/:id", () => {
  it("lists matches for the authenticated user only", async () => {
    mockValidSession();
    prismaMock.match.findMany.mockResolvedValue([]);

    const res = await authedAgent().get("/api/matches");
    expect(res.status).toBe(200);
    expect(res.body.data.matches).toEqual([]);
    expect(prismaMock.match.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ OR: [{ userAId: USER_ID }, { userBId: USER_ID }] }) })
    );
  });

  it("DELETE /api/matches/:id — 404 NOT_FOUND when the match doesn't involve the caller (guessed id), never unmatches someone else's match", async () => {
    mockValidSession();
    prismaMock.match.findUnique.mockResolvedValue({
      id: "match_1",
      userAId: "someone",
      userBId: "someone_else",
      status: "ACTIVE",
    } as any);

    const res = await authedAgent().delete("/api/matches/match_1");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
    expect(prismaMock.match.update).not.toHaveBeenCalled();
  });

  it("DELETE /api/matches/:id — unmatches successfully for a real participant", async () => {
    mockValidSession();
    prismaMock.match.findUnique.mockResolvedValue({
      id: "match_1",
      userAId: USER_ID,
      userBId: "the_other_user",
      status: "ACTIVE",
    } as any);
    prismaMock.match.update.mockResolvedValue({} as any);

    const res = await authedAgent().delete("/api/matches/match_1");
    expect(res.status).toBe(200);
    expect(res.body.data.unmatched).toBe(true);
    expect(prismaMock.match.update).toHaveBeenCalledWith({
      where: { id: "match_1" },
      data: { status: "UNMATCHED" },
    });
  });
});

describe("conversation membership — a caller can't read or post into a conversation that isn't theirs", () => {
  it("GET /api/conversations/:id/messages — 404 NOT_FOUND (not 403) for a non-member, same anti-enumeration reasoning as photo ownership above", async () => {
    mockValidSession();
    prismaMock.conversationMember.findUnique.mockResolvedValue(null);

    const res = await authedAgent().get("/api/conversations/conv_1/messages");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("POST /api/conversations/:id/messages — 400 VALIDATION_ERROR on empty content before touching membership at all", async () => {
    mockValidSession();
    const res = await authedAgent().post("/api/conversations/conv_1/messages").send({ content: "" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(prismaMock.conversationMember.findUnique).not.toHaveBeenCalled();
  });

  it("POST /api/conversations/:id/messages — 403 FORBIDDEN when the other member has blocked (or been blocked by) the sender", async () => {
    mockValidSession();
    prismaMock.conversationMember.findUnique.mockResolvedValue({ conversationId: "conv_1", userId: USER_ID } as any);
    prismaMock.conversation.findUnique.mockResolvedValue({
      id: "conv_1",
      members: [{ userId: USER_ID }, { userId: "other_user" }],
      match: { status: "ACTIVE" },
    } as any);
    prismaMock.block.findUnique
      .mockResolvedValueOnce({ blockerId: USER_ID, blockedId: "other_user" } as any) // blockedByMe
      .mockResolvedValueOnce(null); // blockedMe

    const res = await authedAgent().post("/api/conversations/conv_1/messages").send({ content: "hey" });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
    expect(prismaMock.message.create).not.toHaveBeenCalled();
  });

  it("POST /api/conversations/:id/messages — sends successfully for a real, unblocked member of an active match", async () => {
    mockValidSession();
    prismaMock.conversationMember.findUnique.mockResolvedValue({ conversationId: "conv_1", userId: USER_ID } as any);
    prismaMock.conversation.findUnique.mockResolvedValue({
      id: "conv_1",
      members: [{ userId: USER_ID }, { userId: "other_user" }],
      match: { status: "ACTIVE" },
    } as any);
    prismaMock.block.findUnique.mockResolvedValue(null);
    prismaMock.message.create.mockResolvedValue({
      id: "msg_1",
      conversationId: "conv_1",
      senderId: USER_ID,
      content: "hey!",
      type: "TEXT",
      readAt: null,
      createdAt: new Date(),
    } as any);
    prismaMock.notification.create.mockResolvedValue({} as any);

    const res = await authedAgent().post("/api/conversations/conv_1/messages").send({ content: "hey!" });
    expect(res.status).toBe(201);
    expect(res.body.data.message.content).toBe("hey!");
  });
});

describe("GET /api/calls/turn-credentials", () => {
  it("returns 503 CONFIGURATION_MISSING when no TURN server is configured — the real default, never a fake ICE server list", async () => {
    mockValidSession();
    const res = await authedAgent().get("/api/calls/turn-credentials");
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("CONFIGURATION_MISSING");
  });
});

describe("GET /api/calls/:id — participant-only access", () => {
  it("404s for a call the caller wasn't part of, never leaking that the call exists", async () => {
    mockValidSession();
    prismaMock.call.findUnique.mockResolvedValue({ id: "call_1", callerId: "a", calleeId: "b" } as any);

    const res = await authedAgent().get("/api/calls/call_1");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("200s and returns the call for an actual participant", async () => {
    mockValidSession();
    prismaMock.call.findUnique.mockResolvedValue({ id: "call_1", callerId: USER_ID, calleeId: "b" } as any);

    const res = await authedAgent().get("/api/calls/call_1");
    expect(res.status).toBe(200);
    expect(res.body.data.call.id).toBe("call_1");
  });
});
