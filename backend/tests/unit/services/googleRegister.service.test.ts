import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { mockDeep, mockReset, type DeepMockProxy } from "vitest-mock-extended";

vi.mock("../../../src/config/prisma", () => ({ prisma: mockDeep<PrismaClient>() }));
vi.mock("../../../src/services/email.service", () => ({
  sendVerificationEmail: vi.fn(), sendPasswordResetEmail: vi.fn(), sendAccountDeletionEmail: vi.fn(),
}));
vi.mock("../../../src/services/google.service", () => ({ verifyGoogleIdToken: vi.fn() }));
vi.mock("../../../src/services/subscription.service", () => ({ cancelSubscription: vi.fn() }));

import { prisma } from "../../../src/config/prisma";
import { verifyGoogleIdToken } from "../../../src/services/google.service";
import { registerWithGoogle } from "../../../src/services/auth.service";

const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;
const ADULT = new Date("1996-01-10");
const MINOR = new Date(new Date().getFullYear() - 10, 0, 1);
const ctx = { userAgent: "test", ipAddress: "1.1.1.1" };
const identity = { googleId: "g_1", email: "a@b.com", emailVerified: true };

beforeEach(() => {
  mockReset(prismaMock);
  vi.clearAllMocks();
  (verifyGoogleIdToken as any).mockResolvedValue(identity);
});

describe("registerWithGoogle", () => {
  it("rejects under-age users before creating anything", async () => {
    await expect(registerWithGoogle({ idToken: "t", name: "A", dateOfBirth: MINOR, gender: "WOMAN" }, ctx)).rejects.toMatchObject({ statusCode: 403 });
    expect(prismaMock.user.create).not.toHaveBeenCalled();
  });

  it("rejects when the Google identity or email already has an account", async () => {
    prismaMock.user.findFirst.mockResolvedValue({ id: "u" } as any);
    await expect(registerWithGoogle({ idToken: "t", name: "A", dateOfBirth: ADULT, gender: "WOMAN" }, ctx)).rejects.toMatchObject({ code: "EMAIL_IN_USE" });
    expect(prismaMock.user.create).not.toHaveBeenCalled();
  });

  it("creates a GOOGLE user from the verified identity (not client-supplied email) and trusts Google's email_verified", async () => {
    prismaMock.user.findFirst.mockResolvedValue(null);
    prismaMock.user.create.mockResolvedValue({ id: "u1", email: identity.email, emailVerified: true } as any);
    prismaMock.session.create.mockResolvedValue({ id: "s1" } as any);
    prismaMock.refreshToken.create.mockResolvedValue({} as any);
    const out = await registerWithGoogle({ idToken: "t", name: "A", dateOfBirth: ADULT, gender: "WOMAN" }, ctx);
    const data = (prismaMock.user.create.mock.calls[0][0] as any).data;
    expect(data.email).toBe("a@b.com");
    expect(data.googleId).toBe("g_1");
    expect(data.emailVerified).toBe(true);
    expect(data.provider).toBe("GOOGLE");
    expect(data.passwordHash).toBeUndefined();
    expect(out.user.id).toBe("u1");
  });
});
