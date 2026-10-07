import { describe, it, expect, vi } from "vitest";
import { csrfOriginGuard, isTrustedOrigin } from "../../../src/middleware/security.middleware";

// tests/setup.ts sets APP_ORIGIN=https://app.matchify.test
function run(method: string, headers: Record<string, string> = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const req = { method, get: (h: string) => lower[h.toLowerCase()] } as any;
  const next = vi.fn();
  csrfOriginGuard(req, {} as any, next);
  return next;
}

describe("csrfOriginGuard", () => {
  it("lets safe methods through regardless of origin", () => {
    const next = run("GET", { Origin: "https://evil.example" });
    expect(next).toHaveBeenCalledWith();
  });

  it("allows a state-changing request from the configured app origin", () => {
    expect(run("POST", { Origin: "https://app.matchify.test" })).toHaveBeenCalledWith();
  });

  it("allows a state-changing request from the server's own host (frontend served by the backend)", () => {
    expect(run("POST", { Origin: "https://api.matchify.test", Host: "api.matchify.test" })).toHaveBeenCalledWith();
  });

  it("blocks a cross-site POST with 403 CSRF_BLOCKED", () => {
    const next = run("POST", { Origin: "https://evil.example", Host: "api.matchify.test" });
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403, code: "CSRF_BLOCKED" }));
  });

  it("blocks a cross-site DELETE that only carries a Referer", () => {
    const next = run("DELETE", { Referer: "https://evil.example/page", Host: "api.matchify.test" });
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: "CSRF_BLOCKED" }));
  });

  it("blocks the opaque 'null' origin (sandboxed iframes, some redirects)", () => {
    const next = run("POST", { Origin: "null" });
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: "CSRF_BLOCKED" }));
  });

  it("allows requests with neither Origin nor Referer (curl / server-to-server / webhooks)", () => {
    expect(run("POST")).toHaveBeenCalledWith();
  });
});

describe("isTrustedOrigin", () => {
  it("trusts APP_ORIGIN (ignoring a trailing slash) and rejects anything else", () => {
    expect(isTrustedOrigin("https://app.matchify.test/", undefined)).toBe(true);
    expect(isTrustedOrigin("https://app.matchify.test.evil.example", "api.matchify.test")).toBe(false);
  });
});
