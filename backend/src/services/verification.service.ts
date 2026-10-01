import crypto from "node:crypto";
import { prisma } from "../config/prisma";
import { env } from "../config/env";
import { Errors } from "../utils/apiError";
import * as stripeIdentity from "../integrations/stripeIdentity.provider";
import { recomputeDiscoverability } from "./profile.service";
import { processUploadedImage } from "./image.service";
import { moderateImage } from "./moderation.service";
import { buildVerificationSelfieKey, putObject } from "./storage.service";

const ACTIVE_SESSION_STATUSES = ["PENDING", "PROCESSING"] as const;

export async function startVerification(userId: string) {
  const existingActive = await prisma.verificationSession.findFirst({
    where: { userId, status: { in: [...ACTIVE_SESSION_STATUSES] } },
    orderBy: { createdAt: "desc" },
  });
  // Re-issuing a new provider session while one is already in flight would
  // orphan the first one server-side and could let a user open multiple
  // concurrent verification attempts; just hand back the existing one.
  if (existingActive) {
    return { sessionId: existingActive.id, status: existingActive.status, reused: true };
  }

  const returnUrl = `${env.APP_ORIGIN}/verification/return`;
  const providerSession = await stripeIdentity.createVerificationSession(userId, returnUrl);

  const session = await prisma.verificationSession.create({
    data: {
      userId,
      provider: "stripe_identity",
      providerSessionId: providerSession.id,
      status: "PENDING",
    },
  });

  await prisma.user.update({ where: { id: userId }, data: { verificationStatus: "PENDING" } });

  return {
    sessionId: session.id,
    status: session.status,
    verificationUrl: providerSession.url ?? null,
    clientSecret: providerSession.client_secret ?? null,
    reused: false,
  };
}

// Lower-cost alternative to Stripe Identity: the user uploads a selfie
// directly, a human moderator reviews it via the existing admin
// verification queue (GET /api/admin/verifications, which now also signs a
// URL to view the selfie — see adminModeration.service.ts), and only an
// admin action moves it to VERIFIED or REJECTED. This never auto-approves —
// the backend remains the sole source of truth for verification status,
// same as the Stripe path above.
export async function submitSelfieVerification(userId: string, file: { buffer: Buffer; size: number }) {
  const existingActive = await prisma.verificationSession.findFirst({
    where: { userId, status: { in: [...ACTIVE_SESSION_STATUSES, "MANUAL_REVIEW"] } },
    orderBy: { createdAt: "desc" },
  });
  if (existingActive) {
    return { sessionId: existingActive.id, status: existingActive.status, reused: true };
  }

  // Reuses the same real content-type sniffing / dimension checks / EXIF
  // stripping / re-encoding as regular profile photo uploads — a selfie is
  // still just an image upload as far as that pipeline is concerned.
  const processed = await processUploadedImage(file.buffer);

  // Same automated moderation regular photos get, run before any human ever
  // sees it — catches obviously-wrong uploads (nudity, gore, spam) without
  // burning moderator time, but never auto-approves a real verification on
  // its own: passing this only gets you into MANUAL_REVIEW below, not VERIFIED.
  const moderation = await moderateImage(processed.large.buffer);
  if (moderation.status === "REJECTED") {
    throw Errors.validation("That photo didn't pass our content check. Please upload a clear, appropriate selfie.");
  }

  const session = await prisma.verificationSession.create({
    data: { userId, provider: "selfie_manual_review", status: "MANUAL_REVIEW" },
  });

  const key = buildVerificationSelfieKey(userId, session.id);
  await putObject(key, processed.large.buffer, "image/jpeg");

  await prisma.verificationSession.update({
    where: { id: session.id },
    data: { providerSessionId: key },
  });
  await prisma.user.update({ where: { id: userId }, data: { verificationStatus: "MANUAL_REVIEW" } });
  await prisma.verificationEvent.create({
    data: {
      verificationSessionId: session.id,
      status: "MANUAL_REVIEW",
      rawPayloadHash: crypto.createHash("sha256").update(processed.contentHash).digest("hex"),
    },
  });

  return { sessionId: session.id, status: "MANUAL_REVIEW" as const, reused: false };
}

export async function getStatus(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { verificationStatus: true } });
  if (!user) throw Errors.notFound("User");

  const latestSession = await prisma.verificationSession.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });

  return {
    status: user.verificationStatus,
    session: latestSession
      ? { id: latestSession.id, status: latestSession.status, createdAt: latestSession.createdAt }
      : null,
  };
}

interface StripeWebhookEvent {
  id: string;
  type: string;
  data: { object: { id: string } };
}

// Only these event types move our state machine; anything else (Stripe
// sends many identity.* and unrelated event types to a shared endpoint) is
// intentionally ignored rather than erroring, since Stripe treats a non-2xx
// response as "please retry" and will keep hammering an endpoint that 4xxs
// on events it was never going to act on.
const STATUS_BY_EVENT_TYPE: Record<string, "PROCESSING" | "VERIFIED" | "REJECTED" | "MANUAL_REVIEW"> = {
  "identity.verification_session.processing": "PROCESSING",
  "identity.verification_session.verified": "VERIFIED",
  // requires_input can mean either an outright failure or "needs a human/
  // resubmission" — routing it to manual review rather than an immediate
  // REJECTED avoids auto-rejecting someone over e.g. a blurry photo.
  "identity.verification_session.requires_input": "MANUAL_REVIEW",
  "identity.verification_session.canceled": "REJECTED",
};

export async function handleWebhookEvent(event: StripeWebhookEvent): Promise<void> {
  const mappedStatus = STATUS_BY_EVENT_TYPE[event.type];
  if (!mappedStatus) return;

  const providerSessionId = event.data.object.id;
  const session = await prisma.verificationSession.findFirst({ where: { providerSessionId } });
  // An event for a session this backend never created (different mode/key,
  // stale test data) — ignore rather than error, same reasoning as above.
  if (!session) return;

  // Per the schema's own comment, only a hash of the event is retained
  // (never the raw payload, which can include verification detail we don't
  // need to keep), keyed on Stripe's own event id so redelivery of the same
  // event — normal Stripe behavior on retry, or a duplicate endpoint — is a
  // no-op instead of double-processing.
  const eventHash = crypto.createHash("sha256").update(event.id).digest("hex");

  const applied = await prisma.$transaction(async (tx) => {
    const duplicate = await tx.verificationEvent.findFirst({
      where: { verificationSessionId: session.id, rawPayloadHash: eventHash },
    });
    if (duplicate) return false;

    await tx.verificationEvent.create({
      data: { verificationSessionId: session.id, status: mappedStatus, rawPayloadHash: eventHash },
    });
    await tx.verificationSession.update({ where: { id: session.id }, data: { status: mappedStatus } });
    await tx.user.update({ where: { id: session.userId }, data: { verificationStatus: mappedStatus } });
    return true;
  });

  if (applied) {
    await recomputeDiscoverability(session.userId);
  }
}
