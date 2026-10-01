import { prisma } from "../config/prisma";
import { env } from "../config/env";
import { Errors } from "../utils/apiError";

interface ProfileUpdateInput {
  displayName?: string;
  bio?: string;
  education?: string;
  occupation?: string;
  languages?: string[];
  relationshipIntent?: string;
}

interface PreferencesInput {
  minAge: number;
  maxAge: number;
  maxDistanceKm: number;
  genders: string[];
}

// A profile only becomes visible to others once it's actually complete
// enough to be useful and safe to show: a name, a location, at least one
// moderation-approved photo, and — unless explicitly disabled for local dev
// via REQUIRE_IDENTITY_VERIFICATION=false — a VERIFIED identity. This
// function is the single place that decision lives, so nothing can appear
// in discovery half set up, and it's re-run every time any of those inputs
// change (profile edits, a photo getting approved, a verification webhook).
export async function recomputeDiscoverability(userId: string): Promise<void> {
  const [profile, user] = await Promise.all([
    prisma.profile.findUnique({ where: { userId } }),
    prisma.user.findUnique({ where: { id: userId }, select: { verificationStatus: true, status: true } }),
  ]);
  if (!profile || !user) return;

  const approvedPhotoCount = await prisma.photo.count({ where: { userId, status: "APPROVED" } });
  const isVerifiedEnough = !env.REQUIRE_IDENTITY_VERIFICATION || user.verificationStatus === "VERIFIED";

  const shouldBeDiscoverable = Boolean(
    user.status === "ACTIVE" &&
      profile.displayName &&
      profile.latitude !== null &&
      profile.longitude !== null &&
      approvedPhotoCount > 0 &&
      isVerifiedEnough
  );

  if (shouldBeDiscoverable !== profile.isDiscoverable) {
    await prisma.profile.update({ where: { userId }, data: { isDiscoverable: shouldBeDiscoverable } });
  }
}

export async function getMyProfile(userId: string) {
  const [profile, preferences, interests] = await Promise.all([
    prisma.profile.findUnique({ where: { userId } }),
    prisma.preference.findUnique({ where: { userId } }),
    prisma.userInterest.findMany({ where: { userId }, include: { interest: true } }),
  ]);

  if (!profile) throw Errors.notFound("Profile");

  return {
    displayName: profile.displayName,
    bio: profile.bio,
    education: profile.education,
    occupation: profile.occupation,
    languages: profile.languages,
    relationshipIntent: profile.relationshipIntent,
    isDiscoverable: profile.isDiscoverable,
    hasLocation: profile.latitude !== null && profile.longitude !== null,
    preferences: preferences
      ? {
          minAge: preferences.minAge,
          maxAge: preferences.maxAge,
          maxDistanceKm: preferences.maxDistanceKm,
          genders: preferences.genders,
        }
      : null,
    interests: interests.map((i) => i.interest.name),
  };
}

export async function updateProfile(userId: string, input: ProfileUpdateInput) {
  await prisma.profile.update({ where: { userId }, data: input });
  await recomputeDiscoverability(userId);
}

// Coordinates are stored for server-side distance math only. They must never
// be returned to any other user — discovery responses show a rounded
// distance, never latitude/longitude (see discovery.service.ts).
export async function updateLocation(userId: string, latitude: number, longitude: number) {
  await prisma.profile.update({ where: { userId }, data: { latitude, longitude } });
  await recomputeDiscoverability(userId);
}

export async function updatePreferences(userId: string, input: PreferencesInput) {
  await prisma.preference.upsert({
    where: { userId },
    update: input,
    create: { userId, ...input },
  });
}

export async function updateInterests(userId: string, interestNames: string[]) {
  const normalized = [...new Set(interestNames.map((n) => n.trim().toLowerCase()).filter(Boolean))];

  await prisma.$transaction(async (tx) => {
    const interestIds: string[] = [];
    for (const name of normalized) {
      const interest = await tx.interest.upsert({
        where: { name },
        update: {},
        create: { name },
      });
      interestIds.push(interest.id);
    }

    await tx.userInterest.deleteMany({ where: { userId } });
    if (interestIds.length > 0) {
      await tx.userInterest.createMany({
        data: interestIds.map((interestId) => ({ userId, interestId })),
        skipDuplicates: true,
      });
    }
  });
}
