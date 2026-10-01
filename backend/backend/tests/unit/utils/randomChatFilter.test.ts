import { describe, expect, it } from "vitest";
import { checkMessageContent, SlidingWindowLimiter, normalizeForDuplicateCheck } from "../../../src/utils/randomChatFilter";

describe("checkMessageContent", () => {
  it.each(["hey, how's your day?", "I love hiking and coffee ☕", "I'm 24 and into music", "see you at 7"])("allows %s", (t) => {
    expect(checkMessageContent(t).ok).toBe(true);
  });
  it.each([
    "mail me at foo.bar@gmail.com",
    "foo (at) gmail (dot) com",
    "call 98765 43210",
    "9 8 7 6 5 4 3 2 1 0",
    "+91-98765-43210",
    "check https://evil.example/x",
    "www.scam.io/win",
    "add me on whatsapp +1 555",
    "snapchat: @someone",
    "send me your OTP",
    "my password is hunter2",
  ])("blocks %s", (t) => {
    expect(checkMessageContent(t).ok).toBe(false);
  });
});

describe("SlidingWindowLimiter", () => {
  it("allows up to the limit then reports a wait, then recovers", () => {
    const l = new SlidingWindowLimiter(3, 1000);
    expect(l.take("a", 0)).toBe(0);
    expect(l.take("a", 100)).toBe(0);
    expect(l.take("a", 200)).toBe(0);
    expect(l.take("a", 300)).toBeGreaterThan(0);
    expect(l.take("b", 300)).toBe(0); // per-key
    expect(l.take("a", 1001)).toBe(0); // window slid
  });
});

describe("normalizeForDuplicateCheck", () => {
  it("collapses case and whitespace", () => {
    expect(normalizeForDuplicateCheck("  Hi   THERE ")).toBe("hi there");
  });
});
