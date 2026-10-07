import webpush from "web-push";
import { prisma } from "../config/prisma";
import { env, pushConfigured } from "../config/env";
import { ALWAYS_ON_TYPES, isKnownNotificationType } from "../utils/notificationTypes";

if (pushConfigured) {
  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
}

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

// Upserts on the subscription's endpoint (globally unique per browser
// subscription), not on a client-supplied device id — re-subscribing after
// clearing site data or reinstalling correctly replaces the old row instead
// of leaving a stale, permanently-failing subscription behind.
export async function registerSubscription(
  userId: string,
  subscription: PushSubscriptionInput,
  platform?: string
) {
  return prisma.device.upsert({
    where: { pushEndpoint: subscription.endpoint },
    update: {
      userId,
      pushP256dh: subscription.keys.p256dh,
      pushAuthKey: subscription.keys.auth,
      platform: platform ?? "web",
      lastSeenAt: new Date(),
    },
    create: {
      userId,
      pushEndpoint: subscription.endpoint,
      pushP256dh: subscription.keys.p256dh,
      pushAuthKey: subscription.keys.auth,
      platform: platform ?? "web",
    },
  });
}

export async function unregisterSubscription(userId: string, endpoint: string) {
  await prisma.device.deleteMany({ where: { userId, pushEndpoint: endpoint } });
}

export async function getPreferences(userId: string) {
  const pref = await prisma.notificationPreference.findUnique({ where: { userId } });
  return { disabledTypes: pref?.disabledTypes ?? [] };
}

export async function updatePreferences(userId: string, disabledTypes: string[]) {
  // ALWAYS_ON_TYPES are silently dropped rather than rejected with a 400 —
  // the frontend's toggle list simply shouldn't show them as toggleable, and
  // a stale/forged request can't use this endpoint to go silence them.
  const filtered = disabledTypes.filter((t) => isKnownNotificationType(t) && !ALWAYS_ON_TYPES.includes(t));

  const pref = await prisma.notificationPreference.upsert({
    where: { userId },
    update: { disabledTypes: filtered },
    create: { userId, disabledTypes: filtered },
  });
  return { disabledTypes: pref.disabledTypes };
}

async function isPushEnabledForType(userId: string, type: string): Promise<boolean> {
  if (ALWAYS_ON_TYPES.includes(type as (typeof ALWAYS_ON_TYPES)[number])) return true;
  const pref = await prisma.notificationPreference.findUnique({ where: { userId } });
  return !pref?.disabledTypes.includes(type);
}

interface PushContent {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

// Deliberately generic copy — no message content, no other user's exact
// name lookup here — so a locked phone's notification shade never displays
// something more sensitive than "you have a new message" for a dating app.
function buildPushContent(type: string, payload: Record<string, unknown>): PushContent {
  switch (type) {
    case "MATCH":
      return { title: "New match!", body: "You've got a new match on Matchify.", data: payload };
    case "LIKE":
      return { title: "Someone likes you", body: "You have a new like on Matchify.", data: payload };
    case "MESSAGE":
      return { title: "New message", body: "You have a new message waiting.", data: payload };
    case "CALL":
      return { title: "Incoming call", body: "Someone is calling you on Matchify.", data: payload };
    case "SUBSCRIPTION":
      return { title: "Matchify", body: "There's an update to your subscription.", data: payload };
    case "SECURITY":
      return { title: "Security alert", body: "There was a security event on your account.", data: payload };
    default:
      return { title: "Matchify", body: "You have a new notification.", data: payload };
  }
}

// Never throws — a failed push is a degraded experience, not a failed
// request. The notification row and socket event (the two things the
// frontend actually depends on for correctness) have already succeeded by
// the time this runs; push is a best-effort nudge on top.
export async function sendPushToUser(userId: string, type: string, payload: Record<string, unknown>) {
  if (!pushConfigured) return;

  try {
    if (!(await isPushEnabledForType(userId, type))) return;

    const devices = await prisma.device.findMany({
      where: { userId, pushEndpoint: { not: null } },
    });
    if (devices.length === 0) return;

    const content = buildPushContent(type, payload);

    await Promise.all(
      devices.map(async (device) => {
        if (!device.pushEndpoint || !device.pushP256dh || !device.pushAuthKey) return;
        try {
          await webpush.sendNotification(
            {
              endpoint: device.pushEndpoint,
              keys: { p256dh: device.pushP256dh, auth: device.pushAuthKey },
            },
            JSON.stringify(content)
          );
        } catch (err) {
          const statusCode = (err as { statusCode?: number }).statusCode;
          // 404/410 from the push service means the subscription is gone
          // (browser uninstalled, permission revoked, endpoint expired) —
          // clean it up so future sends don't keep failing against it.
          if (statusCode === 404 || statusCode === 410) {
            await prisma.device.delete({ where: { id: device.id } }).catch(() => {});
          } else {
            console.error("Push send failed:", statusCode, err instanceof Error ? err.message : err);
          }
        }
      })
    );
  } catch (err) {
    console.error("Push notification pipeline error:", err instanceof Error ? err.message : err);
  }
}
