import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { mockDeep, mockReset, type DeepMockProxy } from "vitest-mock-extended";

vi.mock("../../../src/config/prisma", () => ({
  prisma: mockDeep<PrismaClient>(),
}));

import { prisma } from "../../../src/config/prisma";
import { blockUser, unblockUser } from "../../../src/services/block.service";

const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;

beforeEach(() => {
  mockReset(prismaMock);
  vi.clearAllMocks();
});

describe("blockUser", () => {
  it("rejects blocking yourself", async () => {
    await expect(blockUser("user_1", "user_1")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
  });

  it("throws NOT_FOUND for a nonexistent target", async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    await expect(blockUser("user_1", "user_2")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("upserts the block and closes any active match, using the sorted id pair", async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: "user_2" } as any);
    prismaMock.block.upsert.mockResolvedValue({} as any);
    prismaMock.match.updateMany.mockResolvedValue({ count: 1 } as any);

    // "user_2" blocking "user_1" — blocker/blocked order is reversed from the
    // sorted userAId/userBId pair used on Match, so this exercises the sort.
    await blockUser("user_2", "user_1");

    expect(prismaMock.block.upsert).toHaveBeenCalledWith({
      where: { blockerId_blockedId: { blockerId: "user_2", blockedId: "user_1" } },
      update: {},
      create: { blockerId: "user_2", blockedId: "user_1" },
    });
    expect(prismaMock.match.updateMany).toHaveBeenCalledWith({
      where: { userAId: "user_1", userBId: "user_2", status: "ACTIVE" },
      data: { status: "BLOCKED" },
    });
  });
});

describe("unblockUser", () => {
  it("deletes the specific blocker/blocked row", async () => {
    prismaMock.block.deleteMany.mockResolvedValue({ count: 1 } as any);
    await unblockUser("user_1", "user_2");
    expect(prismaMock.block.deleteMany).toHaveBeenCalledWith({
      where: { blockerId: "user_1", blockedId: "user_2" },
    });
  });
});
