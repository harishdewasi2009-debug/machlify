import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { mockDeep, mockReset, type DeepMockProxy } from "vitest-mock-extended";

vi.mock("../../../src/config/prisma", () => ({
  prisma: mockDeep<PrismaClient>(),
}));

vi.mock("../../../src/integrations/razorpay.provider", () => ({
  createOrder: vi.fn(),
}));

vi.mock("../../../src/services/subscription.service", () => ({
  activateFromPayment: vi.fn().mockResolvedValue(undefined),
  revokeForRefundedPayment: vi.fn().mockResolvedValue(undefined),
}));

import { prisma } from "../../../src/config/prisma";
import * as razorpay from "../../../src/integrations/razorpay.provider";
import * as subscriptionService from "../../../src/services/subscription.service";
import { startCheckout, verifyCheckout, handleWebhookEvent } from "../../../src/services/payment.service";

const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;
const RAZORPAY_SECRET = process.env.RAZORPAY_KEY_SECRET || "";

beforeEach(() => {
  mockReset(prismaMock);
  vi.clearAllMocks();
});

describe("startCheckout", () => {
  it("rejects an unknown plan name before calling Razorpay", async () => {
    await expect(startCheckout("user_1", "GOLD")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(razorpay.createOrder).not.toHaveBeenCalled();
  });

  it("creates an order for a valid plan and records a CREATED payment row", async () => {
    vi.mocked(razorpay.createOrder).mockResolvedValue({
      id: "order_1",
      amount: 49900,
      currency: "INR",
      status: "created",
    } as any);
    prismaMock.payment.create.mockResolvedValue({ id: "payment_1" } as any);

    const result = await startCheckout("user_1", "PREMIUM");

    expect(razorpay.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 49900, currency: "INR" })
    );
    expect(prismaMock.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ orderId: "order_1", status: "CREATED", amount: 49900 }),
      })
    );
    expect(result).toMatchObject({ paymentId: "payment_1", orderId: "order_1", plan: "PREMIUM" });
  });
});

describe("verifyCheckout", () => {
  function sign(orderId: string, paymentId: string, secret: string) {
    return crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");
  }

  it("throws NOT_FOUND if no matching payment row exists for this user/order", async () => {
    prismaMock.payment.findFirst.mockResolvedValue(null);
    await expect(
      verifyCheckout("user_1", { orderId: "order_1", paymentId: "pay_1", signature: "x" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("is idempotent: returns success without re-verifying if already PAID (webhook won the race)", async () => {
    prismaMock.payment.findFirst.mockResolvedValue({ id: "payment_1", status: "PAID" } as any);
    const result = await verifyCheckout("user_1", {
      orderId: "order_1",
      paymentId: "pay_1",
      signature: "irrelevant",
    });
    expect(result).toEqual({ status: "PAID", alreadyProcessed: true });
    expect(prismaMock.payment.update).not.toHaveBeenCalled();
  });

  it("rejects re-verifying a payment already in a terminal non-PAID state", async () => {
    prismaMock.payment.findFirst.mockResolvedValue({ id: "payment_1", status: "FAILED" } as any);
    await expect(
      verifyCheckout("user_1", { orderId: "order_1", paymentId: "pay_1", signature: "x" })
    ).rejects.toMatchObject({ code: "PAYMENT_ALREADY_PROCESSED" });
  });

  it("marks the payment FAILED and throws on an invalid signature — never activates on frontend say-so alone", async () => {
    prismaMock.payment.findFirst.mockResolvedValue({ id: "payment_1", status: "CREATED" } as any);
    prismaMock.payment.update.mockResolvedValue({} as any);

    await expect(
      verifyCheckout("user_1", { orderId: "order_1", paymentId: "pay_1", signature: "deadbeef" })
    ).rejects.toMatchObject({ code: "PAYMENT_VERIFICATION_FAILED" });

    expect(prismaMock.payment.update).toHaveBeenCalledWith({
      where: { id: "payment_1" },
      data: { status: "FAILED" },
    });
    expect(subscriptionService.activateFromPayment).not.toHaveBeenCalled();
  });

  it("activates the subscription on a correctly-signed payment", async () => {
    prismaMock.payment.findFirst.mockResolvedValue({ id: "payment_1", status: "CREATED" } as any);
    prismaMock.payment.update.mockResolvedValue({ id: "payment_1", status: "PAID" } as any);
    const signature = sign("order_1", "pay_1", RAZORPAY_SECRET);

    const result = await verifyCheckout("user_1", { orderId: "order_1", paymentId: "pay_1", signature });

    expect(result).toEqual({ status: "PAID", alreadyProcessed: false });
    expect(subscriptionService.activateFromPayment).toHaveBeenCalledWith({ id: "payment_1", status: "PAID" });
  });
});

describe("handleWebhookEvent — idempotency and event handling", () => {
  function eventBody(payload: object) {
    return Buffer.from(JSON.stringify(payload));
  }

  it("skips processing entirely on an exact-body redelivery (already handled)", async () => {
    const body = eventBody({ event: "payment.captured" });
    prismaMock.$transaction.mockResolvedValue(false as any); // duplicate found

    await handleWebhookEvent(body, {
      event: "payment.captured",
      payload: { payment: { entity: { id: "pay_1", order_id: "order_1", status: "captured" } } },
    });

    expect(prismaMock.payment.findFirst).not.toHaveBeenCalled();
  });

  it("activates the subscription on a new payment.captured event, unless /verify already did", async () => {
    prismaMock.$transaction.mockResolvedValue(true as any); // new event
    prismaMock.payment.findFirst.mockResolvedValue({ id: "payment_1", status: "CREATED" } as any);
    prismaMock.payment.update.mockResolvedValue({ id: "payment_1", status: "PAID" } as any);

    await handleWebhookEvent(eventBody({ event: "payment.captured" }), {
      event: "payment.captured",
      payload: { payment: { entity: { id: "pay_1", order_id: "order_1", status: "captured" } } },
    });

    expect(subscriptionService.activateFromPayment).toHaveBeenCalledTimes(1);
  });

  it("is a no-op backstop if /verify already marked the payment PAID", async () => {
    prismaMock.$transaction.mockResolvedValue(true as any);
    prismaMock.payment.findFirst.mockResolvedValue({ id: "payment_1", status: "PAID" } as any);

    await handleWebhookEvent(eventBody({ event: "payment.captured" }), {
      event: "payment.captured",
      payload: { payment: { entity: { id: "pay_1", order_id: "order_1", status: "captured" } } },
    });

    expect(prismaMock.payment.update).not.toHaveBeenCalled();
    expect(subscriptionService.activateFromPayment).not.toHaveBeenCalled();
  });

  it("revokes entitlement on refund.processed", async () => {
    prismaMock.$transaction.mockResolvedValue(true as any);
    prismaMock.payment.findFirst.mockResolvedValue({ id: "payment_1", status: "PAID" } as any);
    prismaMock.payment.update.mockResolvedValue({ id: "payment_1", status: "REFUNDED" } as any);

    await handleWebhookEvent(eventBody({ event: "refund.processed" }), {
      event: "refund.processed",
      payload: { payment: { entity: { id: "pay_1", order_id: "order_1", status: "refunded" } } },
    });

    expect(subscriptionService.revokeForRefundedPayment).toHaveBeenCalledWith({
      id: "payment_1",
      status: "REFUNDED",
    });
  });

  it("silently ignores an event type it has no handler for", async () => {
    prismaMock.$transaction.mockResolvedValue(true as any);

    await expect(
      handleWebhookEvent(eventBody({ event: "order.paid" }), { event: "order.paid", payload: {} })
    ).resolves.toBeUndefined();
    expect(prismaMock.payment.findFirst).not.toHaveBeenCalled();
  });
});
