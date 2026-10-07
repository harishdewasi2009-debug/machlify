import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { mockDeep, mockReset, type DeepMockProxy } from "vitest-mock-extended";

vi.mock("../../../src/config/prisma", () => ({ prisma: mockDeep<PrismaClient>() }));
vi.mock("../../../src/services/email.service", () => ({
  sendVerificationEmail: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
  sendAccountDeletionEmail: vi.fn(),
}));
vi.mock("../../../src/services/google.service", () => ({ verifyGoogleIdToken: vi.fn() }));
vi.mock("../../../src/services/subscription.service", () => ({ cancelSubscription: vi.fn() }));

import { prisma } from "../../../src/config/prisma";
import { verifyGoogleIdToken } from "../../../src/services/google.service";
import { hashPassword } from "../../../src/utils/password";
import { changePassword, loginWithGoogle, refreshSession } from "../../../src/services/auth.service";

const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;

beforeEach(() => {
  mockReset(prismaMock);
  vi.clearAllMocks();
});

describe("refreshSession — reuse of a rotated token", () => {
  it("revokes the whole session (and its refresh tokens), not just rejects", async () => {
    prismaMock.refreshToken.findUnique.mockResolvedValue({
      id: "rt_1",
      revoked: true,
      expiresAt: new Date(Date.now() + 100_000),
      sessionId: "session_1",
      userId: "user_1",
    } as any);

    await expect(refreshSession("stolen-token", {})).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    expect(prismaMock.session.update).toHaveBeenCalledWith({
      where: { id: "session_1" },
      data: { revoked: true },
    });
    expect(prismaMock.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { sessionId: "session_1" },
      data: { revoked: true },
    });
  });
});

describe("loginWithGoogle — unverified email", () => {
  it("never links to an existing password account when Google says the email is unverified", async () => {
    (verifyGoogleIdToken as any).mockResolvedValue({ googleId: "g_evil", email: "victim@example.com", emailVerified: false });
    prismaMock.user.findUnique.mockResolvedValue(null as any); // no account with this googleId yet
    prismaMock.user.findFirst.mockResolvedValue({ id: "victim", email: "victim@example.com" } as any);

    await expect(loginWithGoogle("token", {})).rejects.toMatchObject({ code: "INVALID_TOKEN" });
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });
});

describe("changePassword — session revocation", () => {
  it("revokes every other session but keeps the one that made the change", async () => {
    const passwordHash = await hashPassword("OldPassw0rd1");
    prismaMock.user.findUnique.mockResolvedValue({ id: "user_1", passwordHash } as any);
    prismaMock.user.update.mockResolvedValue({} as any);

    await changePassword("user_1", "OldPassw0rd1", "N3wPassw0rdX!", "session_current");

    expect(prismaMock.session.updateMany).toHaveBeenCalledWith({
      where: { userId: "user_1", revoked: false, id: { not: "session_current" } },
      data: { revoked: true },
    });
    expect(prismaMock.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: "user_1", revoked: false, sessionId: { not: "session_current" } },
      data: { revoked: true },
    });
  });
});
