import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { mockDeep, mockReset, type DeepMockProxy } from "vitest-mock-extended";

vi.mock("../../../src/config/prisma", () => ({
  prisma: mockDeep<PrismaClient>(),
}));

import { prisma } from "../../../src/config/prisma";
import { requireAdminAuth, requireAdminRole } from "../../../src/middleware/adminAuth.middleware";

const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;

function fakeReq(overrides: Record<string, unknown> = {}) {
  return { cookies: {}, ...overrides } as any;
}
function fakeRes() {
  return {} as any;
}

beforeEach(() => {
  mockReset(prismaMock);
  vi.clearAllMocks();
});

describe("requireAdminAuth", () => {
  it("calls next with ADMIN_UNAUTHORIZED when no adminAccessToken cookie is present", async () => {
    const next = vi.fn();
    await requireAdminAuth(fakeReq(), fakeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: "ADMIN_UNAUTHORIZED" }));
  });

  it("never reads the end-user 'accessToken' cookie — a normal user session must not grant admin access", async () => {
    const next = vi.fn();
    await requireAdminAuth(fakeReq({ cookies: { accessToken: "some-user-token" } }), fakeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: "ADMIN_UNAUTHORIZED" }));
    // Since no admin secret is configured in the test env, and no adminAccessToken
    // cookie was even sent, no session lookups should have happened at all.
    expect(prismaMock.adminSession.findUnique).not.toHaveBeenCalled();
  });

  it("collapses an unconfigured admin secret into ADMIN_UNAUTHORIZED rather than crashing or leaking 503", async () => {
    // Default test env has no ADMIN_JWT_SECRET set, so verifyAdminAccessToken
    // throws CONFIGURATION_MISSING internally — the middleware's catch-all
    // must still surface this as a plain 401, not a 503 or an unhandled throw.
    const next = vi.fn();
    await requireAdminAuth(fakeReq({ cookies: { adminAccessToken: "anything" } }), fakeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: "ADMIN_UNAUTHORIZED" }));
  });
});

describe("requireAdminRole", () => {
  it("calls next with ADMIN_FORBIDDEN when req.adminRole is unset", () => {
    const next = vi.fn();
    requireAdminRole("ADMIN")(fakeReq(), fakeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: "ADMIN_FORBIDDEN" }));
  });

  it("calls next with ADMIN_FORBIDDEN when the role isn't in the allowed list", () => {
    const next = vi.fn();
    requireAdminRole("ADMIN")(fakeReq({ adminRole: "MODERATOR" }), fakeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: "ADMIN_FORBIDDEN" }));
  });

  it("calls next() with no error when the role matches", () => {
    const next = vi.fn();
    requireAdminRole("ADMIN", "MODERATOR")(fakeReq({ adminRole: "MODERATOR" }), fakeRes(), next);
    expect(next).toHaveBeenCalledWith();
  });

  it("MODERATOR is not implicitly granted ADMIN-only actions", () => {
    const next = vi.fn();
    requireAdminRole("ADMIN")(fakeReq({ adminRole: "MODERATOR" }), fakeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: "ADMIN_FORBIDDEN" }));
  });
});
