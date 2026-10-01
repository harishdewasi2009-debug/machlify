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
import { sendMessage, getMessages, markConversationRead } from "../../../src/services/chat.service";

const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;

beforeEach(() => {
  mockReset(prismaMock);
  vi.clearAllMocks();
});

describe("sendMessage — validation", () => {
  it("requires a conversationId", async () => {
    await expect(sendMessage("user_1", undefined, "hello")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it("rejects empty/whitespace-only content", async () => {
    await expect(sendMessage("user_1", "conv_1", "   ")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it("rejects content over 2000 characters", async () => {
    await expect(sendMessage("user_1", "conv_1", "a".repeat(2001))).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });
});

describe("sendMessage — authorization", () => {
  it("returns NOT_FOUND (not FORBIDDEN) for a conversation the caller isn't a member of", async () => {
    prismaMock.conversationMember.findUnique.mockResolvedValue(null);
    await expect(sendMessage("user_1", "conv_1", "hi")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects sending into a match that is no longer ACTIVE", async () => {
    prismaMock.conversationMember.findUnique.mockResolvedValue({ id: "member_1" } as any);
    prismaMock.conversation.findUnique.mockResolvedValue({
      id: "conv_1",
      members: [{ userId: "user_1" }, { userId: "user_2" }],
      match: { status: "ACCOUNT_DELETED" },
    } as any);

    await expect(sendMessage("user_1", "conv_1", "hi")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects sending to a user who has blocked (or is blocked by) the caller", async () => {
    prismaMock.conversationMember.findUnique.mockResolvedValue({ id: "member_1" } as any);
    prismaMock.conversation.findUnique.mockResolvedValue({
      id: "conv_1",
      members: [{ userId: "user_1" }, { userId: "user_2" }],
      match: { status: "ACTIVE" },
    } as any);
    prismaMock.block.findUnique
      .mockResolvedValueOnce(null) // blockedByMe
      .mockResolvedValueOnce({ id: "block_1" } as any); // blockedMe

    await expect(sendMessage("user_1", "conv_1", "hi")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("sends successfully and notifies the other member", async () => {
    prismaMock.conversationMember.findUnique.mockResolvedValue({ id: "member_1" } as any);
    prismaMock.conversation.findUnique.mockResolvedValue({
      id: "conv_1",
      members: [{ userId: "user_1" }, { userId: "user_2" }],
      match: { status: "ACTIVE" },
    } as any);
    prismaMock.block.findUnique.mockResolvedValue(null);
    prismaMock.message.create.mockResolvedValue({
      id: "msg_1",
      conversationId: "conv_1",
      senderId: "user_1",
      content: "hi",
      type: "TEXT",
      readAt: null,
      createdAt: new Date(),
    } as any);

    const result = await sendMessage("user_1", "conv_1", "  hi  ");

    expect(prismaMock.message.create).toHaveBeenCalledWith({
      data: { conversationId: "conv_1", senderId: "user_1", content: "hi", type: "TEXT" },
    });
    expect(createNotification).toHaveBeenCalledWith("user_2", "MESSAGE", {
      conversationId: "conv_1",
      fromUserId: "user_1",
    });
    expect(result.content).toBe("hi");
  });
});

describe("getMessages — authorization and content redaction", () => {
  it("throws NOT_FOUND for a non-member", async () => {
    prismaMock.conversationMember.findUnique.mockResolvedValue(null);
    await expect(getMessages("user_1", "conv_1")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("redacts the content of a deleted message but keeps its metadata", async () => {
    prismaMock.conversationMember.findUnique.mockResolvedValue({ id: "member_1" } as any);
    prismaMock.message.findMany.mockResolvedValue([
      {
        id: "msg_1",
        conversationId: "conv_1",
        senderId: "user_2",
        content: "this should be hidden",
        type: "TEXT",
        readAt: null,
        deletedAt: new Date(),
        createdAt: new Date(),
      },
    ] as any);

    const { messages } = await getMessages("user_1", "conv_1");

    expect(messages[0].content).toBeNull();
    expect(messages[0].id).toBe("msg_1");
  });
});

describe("markConversationRead", () => {
  it("throws NOT_FOUND for a non-member before touching messages", async () => {
    prismaMock.conversationMember.findUnique.mockResolvedValue(null);
    await expect(markConversationRead("user_1", "conv_1")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(prismaMock.message.updateMany).not.toHaveBeenCalled();
  });

  it("only marks the other sender's unread messages read, never the caller's own", async () => {
    prismaMock.conversationMember.findUnique.mockResolvedValue({ id: "member_1" } as any);
    await markConversationRead("user_1", "conv_1");
    expect(prismaMock.message.updateMany).toHaveBeenCalledWith({
      where: { conversationId: "conv_1", senderId: { not: "user_1" }, readAt: null },
      data: { readAt: expect.any(Date) },
    });
  });
});
