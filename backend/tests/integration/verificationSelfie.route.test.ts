// Selfie-based verification: POST /api/verification/photo. Storage and
// moderation are mocked at the module boundary (same pattern as
// userRoutes.route.test.ts); image decoding is real.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { mockDeep, mockReset, type DeepMockProxy } from "vitest-mock-extended";
import request from "supertest";
import sharp from "sharp";

vi.mock("../../src/config/prisma", () => ({ prisma: mockDeep<PrismaClient>() }));
vi.mock("../../src/services/storage.service", () => ({
  putObject: vi.fn().mockResolvedValue(undefined),
  deleteObject: vi.fn().mockResolvedValue(undefined),
  getObjectUrl: vi.fn().mockResolvedValue("https://cdn.test/x"),
  buildPhotoKey: vi.fn(),
  buildVerificationSelfieKey: vi.fn((u: string, s: string) => `verification/${u}/${s}`),
  getVerificationSelfieUrl: vi.fn().mockResolvedValue("https://signed.test/selfie"),
}));
vi.mock("../../src/services/moderation.service", () => ({
  moderateImage: vi.fn().mockResolvedValue({ status: "APPROVED", scores: {} }),
}));
vi.mock("../../src/services/push.service", () => ({ sendPushToUser: vi.fn().mockResolvedValue(undefined) }));

import { app } from "../../src/app";
import { prisma } from "../../src/config/prisma";
import { signAccessToken } from "../../src/utils/tokens";
import { putObject } from "../../src/services/storage.service";
import { moderateImage } from "../../src/services/moderation.service";

const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;
const USER_ID = "user_1";
const SESSION_ID = "session_1";
const cookie = () => [`accessToken=${signAccessToken({ sub: USER_ID, sessionId: SESSION_ID })}`];

async function jpeg() {
  return sharp({ create: { width: 400, height: 400, channels: 3, background: { r: 10, g: 90, b: 200 } } }).jpeg().toBuffer();
}

beforeEach(() => {
  mockReset(prismaMock);
  vi.clearAllMocks();
  prismaMock.session.findUnique.mockResolvedValue({
    id: SESSION_ID, revoked: false, expiresAt: new Date(Date.now() + 3600_000),
  } as any);
  prismaMock.user.findUnique.mockResolvedValue({ id: USER_ID, status: "ACTIVE" } as any);
});

describe("POST /api/verification/photo", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await request(app).post("/api/verification/photo");
    expect(res.status).toBe(401);
  });

  it("400s when no file is sent", async () => {
    prismaMock.verificationSession.findFirst.mockResolvedValue(null);
    const res = await request(app).post("/api/verification/photo").set("Cookie", cookie());
    expect(res.status).toBe(400);
  });

  it("stores the selfie privately and queues MANUAL_REVIEW — never VERIFIED", async () => {
    prismaMock.verificationSession.findFirst.mockResolvedValue(null);
    prismaMock.verificationSession.create.mockResolvedValue({ id: "vs_1" } as any);
    prismaMock.verificationSession.update.mockResolvedValue({} as any);
    prismaMock.user.update.mockResolvedValue({} as any);
    prismaMock.verificationEvent.create.mockResolvedValue({} as any);

    const res = await request(app)
      .post("/api/verification/photo")
      .set("Cookie", cookie())
      .attach("file", await jpeg(), { filename: "selfie.jpg", contentType: "image/jpeg" });

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe("MANUAL_REVIEW");
    expect(putObject).toHaveBeenCalledWith("verification/user_1/vs_1", expect.any(Buffer), "image/jpeg");
    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: USER_ID },
      data: { verificationStatus: "MANUAL_REVIEW" },
    });
    // never sets VERIFIED anywhere
    for (const call of prismaMock.user.update.mock.calls) {
      expect(JSON.stringify(call)).not.toContain("VERIFIED\"");
    }
  });

  it("returns the existing session instead of creating a second one", async () => {
    prismaMock.verificationSession.findFirst.mockResolvedValue({ id: "vs_old", status: "MANUAL_REVIEW" } as any);
    const res = await request(app)
      .post("/api/verification/photo")
      .set("Cookie", cookie())
      .attach("file", await jpeg(), { filename: "selfie.jpg", contentType: "image/jpeg" });
    expect(res.status).toBe(201);
    expect(res.body.data.reused).toBe(true);
    expect(prismaMock.verificationSession.create).not.toHaveBeenCalled();
    expect(putObject).not.toHaveBeenCalled();
  });

  it("rejects a non-image file", async () => {
    prismaMock.verificationSession.findFirst.mockResolvedValue(null);
    const res = await request(app)
      .post("/api/verification/photo")
      .set("Cookie", cookie())
      .attach("file", Buffer.from("not an image at all, just text"), { filename: "x.jpg", contentType: "image/jpeg" });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(putObject).not.toHaveBeenCalled();
  });

  it("rejects a selfie that fails content moderation", async () => {
    prismaMock.verificationSession.findFirst.mockResolvedValue(null);
    (moderateImage as any).mockResolvedValueOnce({ status: "REJECTED", scores: {} });
    const res = await request(app)
      .post("/api/verification/photo")
      .set("Cookie", cookie())
      .attach("file", await jpeg(), { filename: "selfie.jpg", contentType: "image/jpeg" });
    expect(res.status).toBe(400);
    expect(prismaMock.verificationSession.create).not.toHaveBeenCalled();
    expect(putObject).not.toHaveBeenCalled();
  });
});
