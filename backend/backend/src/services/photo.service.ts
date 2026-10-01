import crypto from "node:crypto";
import { prisma } from "../config/prisma";
import { env, storageConfigured } from "../config/env";
import { Errors } from "../utils/apiError";
import { processUploadedImage } from "./image.service";
import { moderateImage } from "./moderation.service";
import { buildPhotoKey, deleteObject, getObjectUrl, putObject } from "./storage.service";
import { recomputeDiscoverability } from "./profile.service";

interface UploadedFile {
  buffer: Buffer;
  size: number;
}

interface PhotoResponse {
  id: string;
  status: string;
  isPrimary: boolean;
  position: number;
  createdAt: Date;
  urls: { thumbnail: string; medium: string; large: string };
}

async function toPhotoResponse(photo: {
  id: string;
  status: string;
  isPrimary: boolean;
  position: number;
  createdAt: Date;
  thumbnailKey: string | null;
  mediumKey: string | null;
  largeKey: string | null;
}): Promise<PhotoResponse> {
  const [thumbnail, medium, large] = await Promise.all([
    photo.thumbnailKey ? getObjectUrl(photo.thumbnailKey) : "",
    photo.mediumKey ? getObjectUrl(photo.mediumKey) : "",
    photo.largeKey ? getObjectUrl(photo.largeKey) : "",
  ]);

  return {
    id: photo.id,
    status: photo.status,
    isPrimary: photo.isPrimary,
    position: photo.position,
    createdAt: photo.createdAt,
    urls: { thumbnail, medium, large },
  };
}

export async function uploadPhoto(userId: string, file: UploadedFile): Promise<PhotoResponse> {
  // Fail fast on missing storage config before spending a paid moderation
  // API call on an upload we couldn't store anyway.
  if (!storageConfigured) {
    throw Errors.configurationMissing("Object storage");
  }

  const existingCount = await prisma.photo.count({ where: { userId, status: { not: "REJECTED" } } });
  if (existingCount >= env.MAX_PHOTOS_PER_USER) {
    throw Errors.validation(`You can have at most ${env.MAX_PHOTOS_PER_USER} photos.`);
  }

  const processed = await processUploadedImage(file.buffer);

  const ownDuplicate = await prisma.photo.findFirst({
    where: { userId, contentHash: processed.contentHash },
  });
  if (ownDuplicate) {
    throw Errors.validation("You've already uploaded this photo.");
  }

  // Moderation always runs — this throws a real 503 if the provider isn't
  // configured; it never falls back to auto-approving.
  const moderation = await moderateImage(processed.large.buffer);

  // A photo identical to one already approved on a *different* account is a
  // strong signal of a stolen/reused image — route to a human rather than
  // publishing it automatically, even if the automated moderation passed.
  const reusedElsewhere = await prisma.photo.findFirst({
    where: { contentHash: processed.contentHash, userId: { not: userId }, status: "APPROVED" },
  });
  const status = moderation.status === "APPROVED" && reusedElsewhere ? "MANUAL_REVIEW" : moderation.status;

  const photoId = crypto.randomUUID();
  const keys = {
    original: buildPhotoKey(userId, photoId, "original"),
    large: buildPhotoKey(userId, photoId, "large"),
    medium: buildPhotoKey(userId, photoId, "medium"),
    thumbnail: buildPhotoKey(userId, photoId, "thumbnail"),
  };

  // Store regardless of status (rejected/manual-review photos are kept,
  // unpublished, for audit and admin review) — only *visibility* is gated
  // on status, enforced wherever photos are queried for other users.
  await Promise.all([
    putObject(keys.original, processed.original.buffer, "image/jpeg"),
    putObject(keys.large, processed.large.buffer, "image/jpeg"),
    putObject(keys.medium, processed.medium.buffer, "image/jpeg"),
    putObject(keys.thumbnail, processed.thumbnail.buffer, "image/jpeg"),
  ]);

  const photo = await prisma.photo.create({
    data: {
      id: photoId,
      userId,
      storageKey: keys.original,
      largeKey: keys.large,
      mediumKey: keys.medium,
      thumbnailKey: keys.thumbnail,
      status,
      isPrimary: existingCount === 0 && status === "APPROVED",
      position: existingCount,
      contentHash: processed.contentHash,
      moderationScores: moderation.scores,
    },
  });

  await recomputeDiscoverability(userId);

  return toPhotoResponse(photo);
}

export async function listOwnPhotos(userId: string): Promise<PhotoResponse[]> {
  const photos = await prisma.photo.findMany({
    where: { userId, status: { not: "REJECTED" } },
    orderBy: { position: "asc" },
  });
  return Promise.all(photos.map(toPhotoResponse));
}

export async function reorderPhotos(userId: string, order: string[]): Promise<void> {
  const owned = await prisma.photo.count({ where: { id: { in: order }, userId } });
  if (owned !== order.length) {
    // Object-level authorization: refuse to touch a photo that isn't the
    // caller's, even if its id was simply included in the request body.
    throw Errors.validation("One or more photo ids are invalid.");
  }

  await prisma.$transaction(
    order.map((photoId, index) =>
      prisma.photo.update({ where: { id: photoId }, data: { position: index } })
    )
  );
}

export async function setPrimaryPhoto(userId: string, photoId: string): Promise<void> {
  const photo = await prisma.photo.findUnique({ where: { id: photoId } });
  if (!photo || photo.userId !== userId) throw Errors.notFound("Photo");
  if (photo.status !== "APPROVED") {
    throw Errors.validation("Only an approved photo can be set as primary.");
  }

  await prisma.$transaction([
    prisma.photo.updateMany({ where: { userId }, data: { isPrimary: false } }),
    prisma.photo.update({ where: { id: photoId }, data: { isPrimary: true } }),
  ]);
}

export async function deletePhoto(userId: string, photoId: string): Promise<void> {
  const photo = await prisma.photo.findUnique({ where: { id: photoId } });
  if (!photo || photo.userId !== userId) throw Errors.notFound("Photo");

  await Promise.all(
    [photo.storageKey, photo.largeKey, photo.mediumKey, photo.thumbnailKey]
      .filter((key): key is string => Boolean(key))
      .map((key) => deleteObject(key))
  );

  await prisma.photo.delete({ where: { id: photoId } });

  if (photo.isPrimary) {
    const next = await prisma.photo.findFirst({
      where: { userId, status: "APPROVED" },
      orderBy: { position: "asc" },
    });
    if (next) {
      await prisma.photo.update({ where: { id: next.id }, data: { isPrimary: true } });
    }
  }

  await recomputeDiscoverability(userId);
}
