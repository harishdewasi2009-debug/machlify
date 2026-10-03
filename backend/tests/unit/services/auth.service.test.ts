import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { mockDeep, mockReset, type DeepMockProxy } from "vitest-mock-extended";

vi.mock("../../../src/config/prisma", () => ({
  prisma: mockDeep<PrismaClient>(),
}));

vi.mock("../../../src/services/email.service", () => ({
  sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
  sendPasswordResetEmail: vi.fn().mockResolvedValue(undefined),
  sendAccountDeletionEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/services/google.service", () => ({
  verifyGoogleIdToken: vi.fn(),
}));

vi.mock("../../../src/services/subscription.service", () => ({
  cancelSubscription: vi.fn().mockResolvedValue(undefined),
}));

import { prisma } from "../../../src/config/prisma";
import * as emailService from "../../../src/services/email.service";
import {
  registerUser,
  loginWithPassword,
  refreshSession,
  logout,
  logoutAllDevices,
  requestAccountDeletion,
  restoreAccount,
} from "../../../src/services/auth.service";

const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;

const ADULT_DOB = new Date("1996-01-10");
const MINOR_DOB = new Date(new Date().getFullYear() - 10, 0, 1);

beforeEach(() => {
  mockReset(prismaMock);
  vi.clearAllMocks();
});

describe("registerUser", () => {
  const baseInput = {
    name: "Asha",
    email: "asha@example.com",
    password: "Str0ngPassw0rd",
    dateOfBirth: ADULT_DOB,
    gender: "FEMALE",
  };

  it("rejects a registrant under the minimum age, computed server-side from DOB", async () => {
    await expect(registerUser({ ...baseInput, dateOfBirth: MINOR_DOB })).rejects.toMatchObject({
      code: "UNDER_MINIMUM_AGE",
    });
    // Never even checks for a duplicate email or touches the database for an
    // underage registrant.
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
  });

  it("rejects a password that doesn't meet the strength requirement", async () => {
    await expect(registerUser({ ...baseInput, password: "weak" })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it("rejects a duplicate email", async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: "existing" } as any);
    await expect(registerUser(baseInput)).rejects.toMatchObject({ code: "EMAIL_IN_USE" });
  });

  it("creates the user and a verification token; with no SMTP configured it marks the email verified instead of failing", async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    prismaMock.user.create.mockResolvedValue({ id: "user_1", email: baseInput.email } as any);
    prismaMock.emailVerificationToken.create.mockResolvedValue({} as any);
    prismaMock.user.update.mockResolvedValue({} as any);

    const result = await registerUser(baseInput);

    expect(result).toEqual({ id: "user_1", email: baseInput.email });
    expect(prismaMock.user.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.emailVerificationToken.create).toHaveBeenCalledTimes(1);
    expect(emailService.sendVerificationEmail).not.toHaveBeenCalled();
    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: "user_1" },
      data: { emailVerified: true },
    });
  });
});

describe("loginWithPassword", () => {
  const ctx = { userAgent: "vitest", ipAddress: "127.0.0.1" };

  it("throws INVALID_CREDENTIALS for a nonexistent email (no enumeration)", async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    await expect(loginWithPassword("nobody@example.com", "whatever123", ctx)).rejects.toMatchObject({
      code: "INVALID_CREDENTIALS",
    });
  });

  it("throws ACCOUNT_LOCKED when lockedUntil is in the future, without checking the password", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: "user_1",
      passwordHash: "hash",
      status: "ACTIVE",
      lockedUntil: new Date(Date.now() + 60_000),
      failedLoginAttempts: 5,
    } as any);

    await expect(loginWithPassword("asha@example.com", "whatever123", ctx)).rejects.toMatchObject({
      code: "ACCOUNT_LOCKED",
    });
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it("throws ACCOUNT_SUSPENDED for a non-active, non-pending-deletion account", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: "user_1",
      passwordHash: "hash",
      status: "SUSPENDED",
      lockedUntil: null,
      failedLoginAttempts: 0,
    } as any);

    await expect(loginWithPassword("asha@example.com", "whatever123", ctx)).rejects.toMatchObject({
      code: "ACCOUNT_SUSPENDED",
    });
  });

  it("throws ACCOUNT_PENDING_DELETION (not SUSPENDED) for a pending-deletion account", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: "user_1",
      passwordHash: "hash",
      status: "PENDING_DELETION",
      lockedUntil: null,
      failedLoginAttempts: 0,
    } as any);

    await expect(loginWithPassword("asha@example.com", "whatever123", ctx)).rejects.toMatchObject({
      code: "ACCOUNT_PENDING_DELETION",
    });
  });

  it("increments failedLoginAttempts on a wrong password without locking below the threshold", async () => {
    const { hashPassword } = await import("../../../src/utils/password");
    prismaMock.user.findUnique.mockResolvedValue({
      id: "user_1",
      passwordHash: await hashPassword("correct-password-1"),
      status: "ACTIVE",
      lockedUntil: null,
      failedLoginAttempts: 2,
    } as any);

    await expect(loginWithPassword("asha@example.com", "wrong-password-1", ctx)).rejects.toMatchObject({
      code: "INVALID_CREDENTIALS",
    });

    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: "user_1" },
      data: { failedLoginAttempts: 3, lockedUntil: null },
    });
  });

  it("locks the account once ACCOUNT_LOCK_THRESHOLD failed attempts is reached", async () => {
    const { hashPassword } = await import("../../../src/utils/password");
    prismaMock.user.findUnique.mockResolvedValue({
      id: "user_1",
      passwordHash: await hashPassword("correct-password-1"),
      status: "ACTIVE",
      lockedUntil: null,
      failedLoginAttempts: 4, // default threshold is 5
    } as any);

    await expect(loginWithPassword("asha@example.com", "wrong-password-1", ctx)).rejects.toMatchObject({
      code: "INVALID_CREDENTIALS",
    });

    const call = prismaMock.user.update.mock.calls[0][0] as any;
    expect(call.data.failedLoginAttempts).toBe(0); // reset once it converts into a lock
    expect(call.data.lockedUntil).toBeInstanceOf(Date);
    expect(call.data.lockedUntil.getTime()).toBeGreaterThan(Date.now());
  });

  it("resets failedLoginAttempts and creates a session on a correct password", async () => {
    const { hashPassword } = await import("../../../src/utils/password");
    prismaMock.user.findUnique.mockResolvedValue({
      id: "user_1",
      passwordHash: await hashPassword("correct-password-1"),
      status: "ACTIVE",
      lockedUntil: null,
      failedLoginAttempts: 3,
    } as any);
    prismaMock.session.create.mockResolvedValue({ id: "session_1" } as any);
    prismaMock.refreshToken.create.mockResolvedValue({} as any);

    const result = await loginWithPassword("asha@example.com", "correct-password-1", ctx);

    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: "user_1" },
      data: { failedLoginAttempts: 0, lockedUntil: null },
    });
    expect(result.accessToken).toEqual(expect.any(String));
    expect(result.refreshTokenRaw).toEqual(expect.any(String));
  });
});

describe("refreshSession (rotation + replay detection)", () => {
  const ctx = {};

  it("throws UNAUTHORIZED for an unknown refresh token", async () => {
    prismaMock.refreshToken.findUnique.mockResolvedValue(null);
    await expect(refreshSession("bogus-token", ctx)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("throws UNAUTHORIZED for an already-revoked token (replay of a rotated/stolen token)", async () => {
    prismaMock.refreshToken.findUnique.mockResolvedValue({
      id: "rt_1",
      revoked: true,
      expiresAt: new Date(Date.now() + 100_000),
      sessionId: "session_1",
      userId: "user_1",
    } as any);
    await expect(refreshSession("raw-token", ctx)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("throws UNAUTHORIZED for an expired token", async () => {
    prismaMock.refreshToken.findUnique.mockResolvedValue({
      id: "rt_1",
      revoked: false,
      expiresAt: new Date(Date.now() - 1000),
      sessionId: "session_1",
      userId: "user_1",
    } as any);
    await expect(refreshSession("raw-token", ctx)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("revokes the used token and issues a new one on a valid refresh", async () => {
    prismaMock.refreshToken.findUnique.mockResolvedValue({
      id: "rt_1",
      revoked: false,
      expiresAt: new Date(Date.now() + 100_000),
      sessionId: "session_1",
      userId: "user_1",
    } as any);
    prismaMock.refreshToken.update.mockResolvedValue({} as any);
    prismaMock.session.findUnique.mockResolvedValue({
      id: "session_1",
      revoked: false,
      expiresAt: new Date(Date.now() + 100_000),
    } as any);
    prismaMock.refreshToken.create.mockResolvedValue({} as any);

    const result = await refreshSession("raw-token", ctx);

    expect(prismaMock.refreshToken.update).toHaveBeenCalledWith({
      where: { id: "rt_1" },
      data: { revoked: true },
    });
    expect(result.accessToken).toEqual(expect.any(String));
    expect(result.refreshTokenRaw).toEqual(expect.any(String));
  });
});

describe("logout / logoutAllDevices", () => {
  it("logout revokes only the given session and its refresh tokens", async () => {
    await logout("session_1");
    expect(prismaMock.session.update).toHaveBeenCalledWith({
      where: { id: "session_1" },
      data: { revoked: true },
    });
    expect(prismaMock.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { sessionId: "session_1" },
      data: { revoked: true },
    });
  });

  it("logoutAllDevices revokes every session/refresh token for the user", async () => {
    await logoutAllDevices("user_1");
    expect(prismaMock.session.updateMany).toHaveBeenCalledWith({
      where: { userId: "user_1" },
      data: { revoked: true },
    });
    expect(prismaMock.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: "user_1" },
      data: { revoked: true },
    });
  });
});

describe("requestAccountDeletion", () => {
  it("requires a password when the account has one", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: "user_1",
      status: "ACTIVE",
      passwordHash: "hash",
      email: "a@example.com",
    } as any);

    await expect(requestAccountDeletion("user_1", undefined)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it("rejects the wrong password without touching the account", async () => {
    const { hashPassword } = await import("../../../src/utils/password");
    prismaMock.user.findUnique.mockResolvedValue({
      id: "user_1",
      status: "ACTIVE",
      passwordHash: await hashPassword("correct-1"),
      email: "a@example.com",
    } as any);

    await expect(requestAccountDeletion("user_1", "wrong-1")).rejects.toMatchObject({
      code: "INVALID_CREDENTIALS",
    });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("rejects a request for an account that isn't ACTIVE", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: "user_1",
      status: "PENDING_DELETION",
      passwordHash: null,
      email: "a@example.com",
    } as any);

    await expect(requestAccountDeletion("user_1")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("restoreAccount", () => {
  it("throws INVALID_TOKEN for an unknown/used/expired token", async () => {
    prismaMock.accountDeletionToken.findUnique.mockResolvedValue(null);
    await expect(restoreAccount("bogus")).rejects.toMatchObject({ code: "INVALID_TOKEN" });
  });

  it("throws INVALID_TOKEN if the account was already purged (no longer PENDING_DELETION)", async () => {
    prismaMock.accountDeletionToken.findUnique.mockResolvedValue({
      id: "adt_1",
      usedAt: null,
      expiresAt: new Date(Date.now() + 100_000),
      userId: "user_1",
    } as any);
    prismaMock.user.findUnique.mockResolvedValue({ id: "user_1", status: "DELETED" } as any);

    await expect(restoreAccount("real-token")).rejects.toMatchObject({ code: "INVALID_TOKEN" });
  });

  it("restores an ACTIVE-eligible account and marks the token used", async () => {
    prismaMock.accountDeletionToken.findUnique.mockResolvedValue({
      id: "adt_1",
      usedAt: null,
      expiresAt: new Date(Date.now() + 100_000),
      userId: "user_1",
    } as any);
    prismaMock.user.findUnique.mockResolvedValue({ id: "user_1", status: "PENDING_DELETION" } as any);
    prismaMock.$transaction.mockResolvedValue([{}, {}] as any);

    await restoreAccount("real-token");
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
  });
});
