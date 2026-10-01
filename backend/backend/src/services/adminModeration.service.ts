import { prisma } from "../config/prisma";
import type { PhotoStatus, VerificationStatus } from "@prisma/client";
import { Errors } from "../utils/apiError";
import { recomputeDiscoverability } from "./profile.service";
import { logAdminAction } from "./adminAudit.service";
import { getVerificationSelfieUrl } from "./storage.service";

const PAGE_SIZE = 25;

export async function listPhotos(status: PhotoStatus | undefined, cursor?: string) {
  const photos = await prisma.photo.findMany({
    where: status ? { status } : { status: { in: ["PENDING", "MANUAL_REVIEW"] } },
    orderBy: { createdAt: "asc" }, // oldest-first queue, not newest-first
    take: PAGE_SIZE,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: { user: { select: { email: true } } },
  });

  const nextCursor = photos.length === PAGE_SIZE ? photos[photos.length - 1].id : null;
  // Same gap as the verification queue had: moderators need to actually see
  // the photo to review it. mediumKey (falling back to storageKey) is signed
  // for a short-lived view — never a public URL, regardless of whether
  // S3_PUBLIC_BASE_URL is set for regular approved photos.
  const enrichedPhotos = await Promise.all(
    photos.map(async ({ storageKey, mediumKey, thumbnailKey, largeKey, ...photo }: any) => ({
      ...photo,
      viewUrl: await getVerificationSelfieUrl(mediumKey || storageKey),
    }))
  );
  return { photos: enrichedPhotos, nextCursor };
}

export async function approvePhoto(adminUserId: string, photoId: string) {
  const photo = await prisma.photo.findUnique({ where: { id: photoId } });
  if (!photo) throw Errors.notFound("Photo");

  await prisma.photo.update({ where: { id: photoId }, data: { status: "APPROVED" } });
  await recomputeDiscoverability(photo.userId);
  await logAdminAction(adminUserId, "APPROVE_PHOTO", "Photo", photoId);
}

export async function rejectPhoto(adminUserId: string, photoId: string, reason?: string) {
  const photo = await prisma.photo.findUnique({ where: { id: photoId } });
  if (!photo) throw Errors.notFound("Photo");

  await prisma.photo.update({ where: { id: photoId }, data: { status: "REJECTED" } });
  if (photo.isPrimary) {
    const next = await prisma.photo.findFirst({
      where: { userId: photo.userId, status: "APPROVED" },
      orderBy: { position: "asc" },
    });
    if (next) await prisma.photo.update({ where: { id: next.id }, data: { isPrimary: true } });
  }
  await recomputeDiscoverability(photo.userId);
  await logAdminAction(adminUserId, "REJECT_PHOTO", "Photo", photoId, { reason });
}

export async function listVerifications(status: VerificationStatus | undefined, cursor?: string) {
  const sessions = await prisma.verificationSession.findMany({
    where: status ? { status } : { status: { in: ["MANUAL_REVIEW", "PENDING", "PROCESSING"] } },
    orderBy: { createdAt: "asc" },
    take: PAGE_SIZE,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: { user: { select: { email: true } } },
  });

  const nextCursor = sessions.length === PAGE_SIZE ? sessions[sessions.length - 1].id : null;

  // Selfie-based sessions carry their private storage key in
  // providerSessionId; sign a short-lived URL so the reviewing moderator can
  // actually see the photo. The raw key itself is not exposed.
  const enriched = await Promise.all(
    sessions.map(async ({ providerSessionId, ...session }: any) => ({
      ...session,
      selfieUrl:
        session.provider === "selfie_manual_review" && providerSessionId
          ? await getVerificationSelfieUrl(providerSessionId)
          : null,
    }))
  );
  return { sessions: enriched, nextCursor };
}

// A manual override for the MANUAL_REVIEW state Stripe Identity itself
// asked for (a blurry document, a borderline match) — this is what that
// state exists for. It is never a way to skip real verification: only
// sessions Stripe has already put through its own check land here, and the
// override is itself an audited admin action tied to one adminUserId.
export async function approveVerification(adminUserId: string, sessionId: string) {
  const session = await prisma.verificationSession.findUnique({ where: { id: sessionId } });
  if (!session) throw Errors.notFound("Verification session");

  await prisma.$transaction([
    prisma.verificationSession.update({ where: { id: sessionId }, data: { status: "VERIFIED" } }),
    prisma.user.update({ where: { id: session.userId }, data: { verificationStatus: "VERIFIED" } }),
    prisma.verificationEvent.create({
      data: { verificationSessionId: sessionId, status: "VERIFIED", rawPayloadHash: `admin:${adminUserId}` },
    }),
  ]);
  await recomputeDiscoverability(session.userId);
  await logAdminAction(adminUserId, "APPROVE_VERIFICATION", "VerificationSession", sessionId);
}

export async function rejectVerification(adminUserId: string, sessionId: string, reason?: string) {
  const session = await prisma.verificationSession.findUnique({ where: { id: sessionId } });
  if (!session) throw Errors.notFound("Verification session");

  await prisma.$transaction([
    prisma.verificationSession.update({ where: { id: sessionId }, data: { status: "REJECTED" } }),
    prisma.user.update({ where: { id: session.userId }, data: { verificationStatus: "REJECTED" } }),
    prisma.verificationEvent.create({
      data: { verificationSessionId: sessionId, status: "REJECTED", rawPayloadHash: `admin:${adminUserId}` },
    }),
  ]);
  await recomputeDiscoverability(session.userId);
  await logAdminAction(adminUserId, "REJECT_VERIFICATION", "VerificationSession", sessionId, { reason });
}
