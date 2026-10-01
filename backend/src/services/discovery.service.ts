import { prisma } from "../config/prisma";
import { env } from "../config/env";
import { Errors } from "../utils/apiError";
import { calculateAge, earliestBirthDateForMaxAge, latestBirthDateForMinAge } from "../utils/age";
import { getObjectUrl } from "./storage.service";

const EARTH_RADIUS_KM = 6371;
const CANDIDATE_FETCH_CAP = 300; // bounding-box superset fetched before precise distance filtering

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

// Haversine distance in kilometers.
function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

interface DiscoveryOptions {
  cursor?: number; // simple offset cursor — see note in README about scaling this
  limit?: number;
}

interface DiscoveryProfile {
  id: string;
  name: string;
  age: number;
  bio: string | null;
  distanceKm: number;
  verified: boolean;
  photos: { thumbnail: string; medium: string }[];
}

export async function getDiscoveryFeed(userId: string, options: DiscoveryOptions) {
  const limit = Math.min(options.limit ?? 20, 50);
  const offset = options.cursor ?? 0;

  const me = await prisma.user.findUnique({
    where: { id: userId },
    include: { profile: true, preferences: true },
  });

  if (!me?.profile?.latitude || !me.profile.longitude || !me.preferences) {
    throw Errors.validation("Complete your profile, location, and preferences before browsing discovery.");
  }

  if (env.REQUIRE_IDENTITY_VERIFICATION && me.verificationStatus !== "VERIFIED") {
    throw Errors.forbidden("Complete identity verification before browsing discovery.");
  }

  if (me.preferences.genders.length === 0) {
    throw Errors.validation("Set which genders you're interested in before browsing discovery.");
  }

  const myAge = calculateAge(me.dateOfBirth);
  const { latitude: myLat, longitude: myLon } = me.profile;
  const { minAge, maxAge, maxDistanceKm, genders } = me.preferences;

  // Bounding box in degrees, used only to cheaply shrink the SQL result set
  // before precise haversine filtering happens in application code. At real
  // scale, replace this with a PostGIS geography column + GiST index instead
  // of fetching a superset and filtering in JS.
  const latDelta = maxDistanceKm / 111;
  const lonDelta = maxDistanceKm / (111 * Math.max(Math.cos(toRadians(myLat)), 0.01));

  const [blocksMade, blocksReceived, swiped] = await Promise.all([
    prisma.block.findMany({ where: { blockerId: userId }, select: { blockedId: true } }),
    prisma.block.findMany({ where: { blockedId: userId }, select: { blockerId: true } }),
    prisma.swipe.findMany({ where: { actorId: userId }, select: { targetId: true } }),
  ]);

  const excludedIds = new Set<string>([
    userId,
    ...blocksMade.map((b) => b.blockedId),
    ...blocksReceived.map((b) => b.blockerId),
    ...swiped.map((s) => s.targetId),
  ]);

  const candidates = await prisma.user.findMany({
    where: {
      id: { notIn: [...excludedIds] },
      status: "ACTIVE",
      gender: genders.length > 0 ? { in: genders } : undefined,
      dateOfBirth: { lte: latestBirthDateForMinAge(minAge), gte: earliestBirthDateForMaxAge(maxAge) },
      profile: {
        isDiscoverable: true,
        latitude: { gte: myLat - latDelta, lte: myLat + latDelta },
        longitude: { gte: myLon - lonDelta, lte: myLon + lonDelta },
      },
      // Mutual match: the candidate's own preferences must also include this
      // viewer's gender and age. A one-sided filter would surface people to
      // you who've explicitly said they don't want to see people like you.
      preferences: {
        genders: { has: me.gender },
        minAge: { lte: myAge },
        maxAge: { gte: myAge },
      },
    },
    include: {
      profile: true,
      photos: { where: { status: "APPROVED" }, orderBy: { position: "asc" }, take: 6 },
    },
    take: CANDIDATE_FETCH_CAP,
  });

  const withDistance = candidates
    .map((c) => ({
      user: c,
      distance: distanceKm(myLat, myLon, c.profile!.latitude!, c.profile!.longitude!),
    }))
    .filter((c) => c.distance <= maxDistanceKm)
    .sort((a, b) => a.distance - b.distance);

  const page = withDistance.slice(offset, offset + limit);

  const profiles: DiscoveryProfile[] = await Promise.all(
    page.map(async ({ user, distance }) => ({
      id: user.id,
      name: user.profile!.displayName,
      age: calculateAge(user.dateOfBirth),
      bio: user.profile!.bio,
      // Rounded distance only — exact coordinates are never sent to another user.
      distanceKm: Math.round(distance),
      verified: user.verificationStatus === "VERIFIED",
      photos: await Promise.all(
        user.photos.map(async (p) => ({
          thumbnail: p.thumbnailKey ? await getObjectUrl(p.thumbnailKey) : "",
          medium: p.mediumKey ? await getObjectUrl(p.mediumKey) : "",
        }))
      ),
    }))
  );

  const nextCursor = offset + limit < withDistance.length ? offset + limit : null;

  return { profiles, nextCursor };
}
