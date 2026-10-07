import { prisma } from "../config/prisma";
import { env } from "../config/env";
import { Errors } from "../utils/apiError";
import { calculateAge, earliestBirthDateForMaxAge, latestBirthDateForMinAge } from "../utils/age";
import { getObjectUrl } from "./storage.service";

const CANDIDATE_FETCH_CAP = 300;

interface DiscoveryOptions {
  cursor?: number; // simple offset cursor — see note in README about scaling this
  limit?: number;
}

interface DiscoveryProfile {
  id: string;
  name: string;
  age: number;
  bio: string | null;
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

  // Location is no longer required: people can create a profile from anywhere.
  if (!me?.profile || !me.preferences) {
    throw Errors.validation("Complete your profile and preferences before browsing discovery.");
  }

  if (env.REQUIRE_IDENTITY_VERIFICATION && me.verificationStatus !== "VERIFIED") {
    throw Errors.forbidden("Complete identity verification before browsing discovery.");
  }

  if (me.preferences.genders.length === 0) {
    throw Errors.validation("Set which genders you're interested in before browsing discovery.");
  }

  const myAge = calculateAge(me.dateOfBirth);
  const { minAge, maxAge, genders } = me.preferences;

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
      photos: { where: { status: "APPROVED" }, orderBy: [{ isPrimary: "desc" }, { position: "asc" }], take: 6 },
    },
    orderBy: { createdAt: "desc" },
    take: CANDIDATE_FETCH_CAP,
  });

  const ordered = candidates;

  const page = ordered.slice(offset, offset + limit);

  const profiles: DiscoveryProfile[] = await Promise.all(
    page.map(async (user) => ({
      id: user.id,
      name: user.profile!.displayName,
      age: calculateAge(user.dateOfBirth),
      bio: user.profile!.bio,
      verified: user.verificationStatus === "VERIFIED",
      photos: await Promise.all(
        user.photos.map(async (p) => ({
          thumbnail: p.thumbnailKey ? await getObjectUrl(p.thumbnailKey) : "",
          medium: p.mediumKey ? await getObjectUrl(p.mediumKey) : "",
        }))
      ),
    }))
  );

  const nextCursor = offset + limit < ordered.length ? offset + limit : null;

  return { profiles, nextCursor };
}
