import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { mockDeep, mockReset, type DeepMockProxy } from "vitest-mock-extended";

vi.mock("../../../src/config/prisma", () => ({
  prisma: mockDeep<PrismaClient>(),
}));

import { prisma } from "../../../src/config/prisma";
import { signAccessToken } from "../../../src/utils/tokens";
import { requireAuth } from "../../../src/middleware/auth.middleware";

const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;

function fakeReq(cookies: Record<string, string> = {}) {
  return { cookies } as any;
}
function fakeRes() {
  return {} as any;
}

beforeEach(() => {
  mockReset(prismaMock);
  vi.clearAllMocks();
});

describe("requireAuth", () => {
  it("calls next with UNAUTHORIZED when no accessToken cookie is present", async () => {
    const next = vi.fn();
    await requireAuth(fakeReq(), fakeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: "UNAUTHORIZED" }));
  });

  it("calls next with UNAUTHORIZED for a garbage/forged token, never throwing out of the middleware", async () => {
    const next = vi.fn();
    await requireAuth(fakeReq({ accessToken: "not-a-real-jwt" }), fakeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: "UNAUTHORIZED" }));
  });

  it("calls next with UNAUTHORIZED when the session no longer exists", async () => {
    const token = signAccessToken({ sub: "user_1", sessionId: "session_1" });
    prismaMock.session.findUnique.mockResolvedValue(null);

    const next = vi.fn();
    await requireAuth(fakeReq({ accessToken: token }), fakeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: "UNAUTHORIZED" }));
  });

  it("calls next with UNAUTHORIZED when the session has been revoked", async () => {
    const token = signAccessToken({ sub: "user_1", sessionId: "session_1" });
    prismaMock.session.findUnique.mockResolvedValue({
      id: "session_1",
      revoked: true,
      expiresAt: new Date(Date.now() + 100_000),
    } as any);

    const next = vi.fn();
    await requireAuth(fakeReq({ accessToken: token }), fakeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: "UNAUTHORIZED" }));
  });

  it("calls next with UNAUTHORIZED when the session has expired", async () => {
    const token = signAccessToken({ sub: "user_1", sessionId: "session_1" });
    prismaMock.session.findUnique.mockResolvedValue({
      id: "session_1",
      revoked: false,
      expiresAt: new Date(Date.now() - 1000),
    } as any);

    const next = vi.fn();
    await requireAuth(fakeReq({ accessToken: token }), fakeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: "UNAUTHORIZED" }));
  });

  it("calls next with UNAUTHORIZED when the user backing a valid session is no longer ACTIVE", async () => {
    const token = signAccessToken({ sub: "user_1", sessionId: "session_1" });
    prismaMock.session.findUnique.mockResolvedValue({
      id: "session_1",
      revoked: false,
      expiresAt: new Date(Date.now() + 100_000),
    } as any);
    prismaMock.user.findUnique.mockResolvedValue({ id: "user_1", status: "SUSPENDED" } as any);

    const next = vi.fn();
    await requireAuth(fakeReq({ accessToken: token }), fakeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: "UNAUTHORIZED" }));
  });

  it("attaches userId/sessionId to the request and calls next() with no error on success", async () => {
    const token = signAccessToken({ sub: "user_1", sessionId: "session_1" });
    prismaMock.session.findUnique.mockResolvedValue({
      id: "session_1",
      revoked: false,
      expiresAt: new Date(Date.now() + 100_000),
    } as any);
    prismaMock.user.findUnique.mockResolvedValue({ id: "user_1", status: "ACTIVE" } as any);

    const req = fakeReq({ accessToken: token });
    const next = vi.fn();
    await requireAuth(req, fakeRes(), next);

    expect(next).toHaveBeenCalledWith(); // called with no arguments = proceed
    expect(req.userId).toBe("user_1");
    expect(req.sessionId).toBe("session_1");
  });
});
