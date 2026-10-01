import { describe, it, expect, vi, afterEach } from "vitest";

describe("admin tokens — unconfigured (default test env has no ADMIN_JWT_SECRET)", () => {
  it("signAdminAccessToken throws CONFIGURATION_MISSING rather than signing with an empty secret", async () => {
    const { signAdminAccessToken } = await import("../../../src/utils/adminTokens");
    expect(() => signAdminAccessToken({ sub: "admin_1", adminSessionId: "asess_1", role: "ADMIN" })).toThrowError(
      /not configured/i
    );
  });

  it("verifyAdminAccessToken throws CONFIGURATION_MISSING rather than verifying with an empty secret", async () => {
    const { verifyAdminAccessToken } = await import("../../../src/utils/adminTokens");
    expect(() => verifyAdminAccessToken("some.jwt.token")).toThrowError(/not configured/i);
  });
});

describe("admin tokens — configured", () => {
  afterEach(() => {
    vi.doUnmock("../../../src/config/env");
    vi.resetModules();
  });

  it("round-trips a payload through sign/verify once ADMIN_JWT_SECRET is set", async () => {
    vi.resetModules();
    vi.doMock("../../../src/config/env", () => ({
      env: { ADMIN_JWT_SECRET: "a-real-admin-secret-for-this-test", ADMIN_SESSION_TTL_HOURS: 12 },
    }));

    const { signAdminAccessToken, verifyAdminAccessToken } = await import("../../../src/utils/adminTokens");

    const token = signAdminAccessToken({ sub: "admin_1", adminSessionId: "asess_1", role: "ADMIN" });
    const payload = verifyAdminAccessToken(token);

    expect(payload.sub).toBe("admin_1");
    expect(payload.adminSessionId).toBe("asess_1");
    expect(payload.role).toBe("ADMIN");
  });

  it("a token signed under one ADMIN_JWT_SECRET does not verify under a different one", async () => {
    vi.resetModules();
    vi.doMock("../../../src/config/env", () => ({
      env: { ADMIN_JWT_SECRET: "secret-A", ADMIN_SESSION_TTL_HOURS: 12 },
    }));
    const { signAdminAccessToken } = await import("../../../src/utils/adminTokens");
    const token = signAdminAccessToken({ sub: "admin_1", adminSessionId: "asess_1", role: "ADMIN" });

    vi.doUnmock("../../../src/config/env");
    vi.resetModules();
    vi.doMock("../../../src/config/env", () => ({
      env: { ADMIN_JWT_SECRET: "secret-B", ADMIN_SESSION_TTL_HOURS: 12 },
    }));
    const { verifyAdminAccessToken } = await import("../../../src/utils/adminTokens");

    expect(() => verifyAdminAccessToken(token)).toThrow();
  });
});
