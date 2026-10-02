import { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma";
import { Errors } from "../utils/apiError";
import { emitToUser } from "../websocket/socket";
import { sendPushToUser } from "./push.service";

const NOTIFICATION_PAGE_SIZE = 30;

export async function createNotification(userId: string, type: string, payload: Record<string, unknown>) {
  const notification = await prisma.notification.create({ data: { userId, type, payload: payload as Prisma.InputJsonObject } });
  // The row is the source of truth (so GET /api/notifications always reflects
  // reality even if the user was offline); the socket push is a live nudge on
  // top of it for a connected client, not a replacement for it.
  emitToUser(userId, "notification:new", notification);
  // Push goes to devices that aren't even looking at the app right now —
  // independent of whether a socket is connected. Fire-and-forget: it never
  // blocks or fails the caller (match/message/call creation), see
  // push.service's own error handling.
  void sendPushToUser(userId, type, payload);
  return notification;
}

export async function listNotifications(userId: string, cursor?: string) {
  const notifications = await prisma.notification.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: NOTIFICATION_PAGE_SIZE,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const nextCursor =
    notifications.length === NOTIFICATION_PAGE_SIZE
      ? notifications[notifications.length - 1].id
      : null;

  return { notifications, nextCursor };
}

export async function markNotificationRead(userId: string, notificationId: string) {
  const result = await prisma.notification.updateMany({
    where: { id: notificationId, userId },
    data: { readAt: new Date() },
  });
  if (result.count === 0) throw Errors.notFound("Notification");
}

export async function markAllNotificationsRead(userId: string) {
  await prisma.notification.updateMany({
    where: { userId, readAt: null },
    data: { readAt: new Date() },
  });
}

export { getPreferences, updatePreferences } from "./push.service";
