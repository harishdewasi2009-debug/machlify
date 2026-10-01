import { prisma } from "../../config/prisma";
import { env } from "../../config/env";
import { Errors } from "../../utils/apiError";

export interface SettingsInput {
  visibility?: "PUBLIC" | "RANDOM_CHAT" | "MATCH_ONLY" | "PRIVATE";
  showAge?: boolean;
  showLocation?: boolean;
  showBio?: boolean;
  showInterests?: boolean;
  locationLabel?: string | null;
  prefMinAge?: number;
  prefMaxAge?: number;
  prefGenders?: string[]; // empty = Anyone
  prefLanguages?: string[]; // empty = Anyone
  prefInterests?: string[]; // empty = Anyone
  prefSameRegion?: boolean;
}

export async function getSettings(userId: string) {
  const [settings, interests, profile] = await Promise.all([
    prisma.randomChatSettings.upsert({ where: { userId }, update: {}, create: { userId } }),
    prisma.userInterest.findMany({ where: { userId }, include: { interest: true } }),
    prisma.profile.findUnique({ where: { userId }, select: { languages: true } }),
  ]);
  return {
    ...settings,
    userId: undefined, // never echoed back
    createdAt: undefined,
    myInterests: interests.map((i) => i.interest.name),
    myLanguages: profile?.languages ?? [],
    minAgeAllowed: env.MIN_AGE_YEARS,
  };
}

export async function updateSettings(userId: string, input: SettingsInput) {
  const data: SettingsInput = { ...input };

  if (data.prefMinAge !== undefined || data.prefMaxAge !== undefined) {
    const current = await prisma.randomChatSettings.findUnique({ where: { userId } });
    const min = Math.max(env.MIN_AGE_YEARS, data.prefMinAge ?? current?.prefMinAge ?? env.MIN_AGE_YEARS);
    const max = Math.min(99, data.prefMaxAge ?? current?.prefMaxAge ?? 99);
    if (min > max) throw Errors.validation("Minimum age can't be above the maximum age.");
    data.prefMinAge = min;
    data.prefMaxAge = max;
  }
  if (data.locationLabel !== undefined && data.locationLabel !== null) {
    data.locationLabel = data.locationLabel.trim().slice(0, 60) || null;
  }
  if (data.prefLanguages) data.prefLanguages = [...new Set(data.prefLanguages.map((l) => l.trim()).filter(Boolean))].slice(0, 8);
  if (data.prefInterests) data.prefInterests = [...new Set(data.prefInterests.map((l) => l.trim().toLowerCase()).filter(Boolean))].slice(0, 12);
  if (data.prefGenders) data.prefGenders = [...new Set(data.prefGenders.map((g) => g.trim()).filter(Boolean))].slice(0, 6);

  await prisma.randomChatSettings.upsert({
    where: { userId },
    update: data,
    create: { userId, ...data },
  });
  return getSettings(userId);
}
