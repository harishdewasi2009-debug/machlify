import { prisma } from "../config/prisma";

const PAGE_SIZE = 25;

export async function listPayments(status: string | undefined, cursor?: string) {
  const payments = await prisma.payment.findMany({
    where: status ? { status } : {},
    orderBy: { createdAt: "desc" },
    take: PAGE_SIZE,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: { user: { select: { email: true } } },
  });

  const nextCursor = payments.length === PAGE_SIZE ? payments[payments.length - 1].id : null;
  return { payments, nextCursor };
}

export async function listSubscriptions(status: string | undefined, cursor?: string) {
  const subscriptions = await prisma.subscription.findMany({
    where: status ? { status } : {},
    orderBy: { createdAt: "desc" },
    take: PAGE_SIZE,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: { user: { select: { email: true } } },
  });

  const nextCursor = subscriptions.length === PAGE_SIZE ? subscriptions[subscriptions.length - 1].id : null;
  return { subscriptions, nextCursor };
}
