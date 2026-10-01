import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { mockDeep, mockReset, type DeepMockProxy } from "vitest-mock-extended";

vi.mock("../../../src/config/prisma", () => ({
  prisma: mockDeep<PrismaClient>(),
}));

vi.mock("../../../src/services/notification.service", () => ({
  createNotification: vi.fn().mockResolvedValue(undefined),
}));

import { prisma } from "../../../src/config/prisma";
import { createNotification } from "../../../src/services/notification.service";
import { recordSwipe } from "../../../src/services/swipe.service";

const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;

const VERIFIED_ACTOR = { verificationStatus: "VERIFIED" };

beforeEach(() => {
  mockReset(prismaMock);
  vi.clearAllMocks();
  // Verification is required by default (REQUIRE_IDENTITY_VERIFICATION=true);
  // most tests aren't about that gate, so satisfy it up front.
  prismaMock.user.findUnique.mockResolvedValue(VERIFIED_ACTOR as any);
  prismaMock.block.findUnique.mockResolvedValue(null);
});

describe("recordSwipe — guard rails", () => {
  it("rejects swiping on yourself before touching the database", async () => {
    await expect(recordSwipe("user_1", "user_1", true)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
  });

  it("rejects an unverified actor when identity verification is required", async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce({ verificationStatus: "PENDING" } as any);
    await expect(recordSwipe("user_1", "user_2", true)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("returns 404 (not a distinguishing error) for a nonexistent target", async () => {
    prismaMock.user.findUnique
      .mockResolvedValueOnce(VERIFIED_ACTOR as any) // actor lookup
      .mockResolvedValueOnce(null); // target lookup
    await expect(recordSwipe("user_1", "user_2", true)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("returns the same 404 for a target blocked either direction, not a distinct error", async () => {
    prismaMock.user.findUnique
      .mockResolvedValueOnce(VERIFIED_ACTOR as any)
      .mockResolvedValueOnce({ id: "user_2", status: "ACTIVE" } as any);
    prismaMock.block.findUnique
      .mockResolvedValueOnce(null) // blockedByMe
      .mockResolvedValueOnce({ id: "block_1" } as any); // blockedMe
    await expect(recordSwipe("user_1", "user_2", true)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects a duplicate swipe on the same target", async () => {
    prismaMock.user.findUnique
      .mockResolvedValueOnce(VERIFIED_ACTOR as any)
      .mockResolvedValueOnce({ id: "user_2", status: "ACTIVE" } as any);
    prismaMock.swipe.findUnique.mockResolvedValueOnce({ id: "existing_swipe" } as any);
    await expect(recordSwipe("user_1", "user_2", true)).rejects.toMatchObject({ code: "ALREADY_SWIPED" });
  });
});

describe("recordSwipe — pass and one-sided like", () => {
  it("a pass is recorded and never checked for a match", async () => {
    prismaMock.user.findUnique
      .mockResolvedValueOnce(VERIFIED_ACTOR as any)
      .mockResolvedValueOnce({ id: "user_2", status: "ACTIVE" } as any);
    prismaMock.swipe.findUnique.mockResolvedValueOnce(null); // no existing swipe
    prismaMock.swipe.create.mockResolvedValueOnce({} as any);

    const result = await recordSwipe("user_1", "user_2", false);

    expect(result).toEqual({ liked: false, matched: false });
    // Only the "existing swipe" lookup should have run — no reciprocal-like check.
    expect(prismaMock.swipe.findUnique).toHaveBeenCalledTimes(1);
  });

  it("a like with no reciprocal like yet is not a match", async () => {
    prismaMock.user.findUnique
      .mockResolvedValueOnce(VERIFIED_ACTOR as any)
      .mockResolvedValueOnce({ id: "user_2", status: "ACTIVE" } as any);
    prismaMock.swipe.findUnique
      .mockResolvedValueOnce(null) // no existing swipe from actor
      .mockResolvedValueOnce(null); // no reciprocal like
    prismaMock.swipe.create.mockResolvedValueOnce({} as any);

    const result = await recordSwipe("user_1", "user_2", true);

    expect(result).toEqual({ liked: true, matched: false });
    expect(createNotification).not.toHaveBeenCalled();
  });
});

describe("recordSwipe — mutual like creates a match", () => {
  it("sorts user ids into canonical order regardless of who liked last", async () => {
    // "user_2" liking "user_1" back — actorId > targetId alphabetically, so the
    // match must still be created with userAId/userBId sorted, not actor-first.
    prismaMock.user.findUnique
      .mockResolvedValueOnce(VERIFIED_ACTOR as any)
      .mockResolvedValueOnce({ id: "user_1", status: "ACTIVE" } as any);
    prismaMock.swipe.findUnique
      .mockResolvedValueOnce(null) // no existing swipe from actor (user_2 -> user_1)
      .mockResolvedValueOnce({ liked: true } as any); // reciprocal: user_1 already liked user_2
    prismaMock.swipe.create.mockResolvedValueOnce({} as any);

    prismaMock.$transaction.mockImplementationOnce(async (fn: any) => {
      const tx = {
        match: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: "match_1" }),
        },
        conversation: {
          create: vi.fn().mockResolvedValue({ id: "conversation_1" }),
        },
        conversationMember: {
          createMany: vi.fn().mockResolvedValue({ count: 2 }),
        },
      };
      const result = await fn(tx);
      // The match must be looked up/created with the alphabetically-sorted pair.
      expect(tx.match.findUnique).toHaveBeenCalledWith({
        where: { userAId_userBId: { userAId: "user_1", userBId: "user_2" } },
        include: { conversation: true },
      });
      expect(tx.match.create).toHaveBeenCalledWith({ data: { userAId: "user_1", userBId: "user_2" } });
      return result;
    });

    const result = await recordSwipe("user_2", "user_1", true);

    expect(result.matched).toBe(true);
    expect(result.matchId).toBe("match_1");
    expect(result.conversationId).toBe("conversation_1");
    expect(createNotification).toHaveBeenCalledTimes(2);
  });

  it("does not re-notify or re-create a match that already exists", async () => {
    prismaMock.user.findUnique
      .mockResolvedValueOnce(VERIFIED_ACTOR as any)
      .mockResolvedValueOnce({ id: "user_2", status: "ACTIVE" } as any);
    prismaMock.swipe.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ liked: true } as any);
    prismaMock.swipe.create.mockResolvedValueOnce({} as any);

    prismaMock.$transaction.mockImplementationOnce(async (fn: any) => {
      const tx = {
        match: {
          findUnique: vi.fn().mockResolvedValue({
            id: "existing_match",
            conversation: { id: "existing_conversation" },
          }),
          create: vi.fn(),
        },
        conversation: { create: vi.fn() },
        conversationMember: { createMany: vi.fn() },
      };
      const result = await fn(tx);
      expect(tx.match.create).not.toHaveBeenCalled();
      return result;
    });

    const result = await recordSwipe("user_1", "user_2", true);

    expect(result.matched).toBe(true);
    expect(result.matchId).toBe("existing_match");
    expect(createNotification).not.toHaveBeenCalled();
  });
});
