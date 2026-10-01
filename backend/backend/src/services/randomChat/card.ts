import { prisma } from "../../config/prisma";
import { calculateAge } from "../../utils/age";
import { interestEmoji } from "../../utils/randomChatFilter";
import { getObjectUrl } from "../storage.service";

export interface PartnerCard {
  displayName: string;
  age: number | null;
  location: string | null;
  bio: string | null;
  interests: { name: string; emoji: string }[];
  photo: string | null;
  verified: boolean;
  compatibility: { score: number; sharedInterests: string[]; sharedLanguages: string[]; sameIntent: boolean } | null;
}

export interface FullProfile extends PartnerCard {
  photos: string[];
  about: { relationshipIntent: string | null; education: string | null; occupation: string | null; languages: string[] } | null;
}

// Builds what `viewerId` is allowed to see about `targetId`. This is the ONE
// place that decides what leaves the server about another member during
// Random Chat: it returns no user id, email, phone, coordinates, or anything
// the target hasn't switched on in their RandomChatSettings.
export async function buildProfile(viewerId: string, targetId: string, full: boolean): Promise<FullProfile> {
  const [target, viewerInterests, viewerProfile] = await Promise.all([
    prisma.user.findUnique({
      where: { id: targetId },
      include: {
        profile: true,
        randomChatSettings: true,
        userInterests: { include: { interest: true } },
        photos: { where: { status: "APPROVED" }, orderBy: [{ isPrimary: "desc" }, { position: "asc" }], take: full ? 6 : 1 },
      },
    }),
    prisma.userInterest.findMany({ where: { userId: viewerId }, include: { interest: true } }),
    prisma.profile.findUnique({ where: { userId: viewerId }, select: { languages: true, relationshipIntent: true } }),
  ]);

  const settings = target?.randomChatSettings;
  if (!target || !target.profile) {
    return { displayName: "Matchify member", age: null, location: null, bio: null, interests: [], photo: null, verified: false, compatibility: null, photos: [], about: null };
  }

  const showAge = settings?.showAge ?? true;
  const showInterests = settings?.showInterests ?? true;
  const showBio = settings?.showBio ?? true;
  const showLocation = settings?.showLocation ?? false;

  const theirInterests = target.userInterests.map((ui) => ui.interest.name);
  const myInterests = new Set(viewerInterests.map((ui) => ui.interest.name));
  const visibleInterests = showInterests ? theirInterests : [];

  const shared = visibleInterests.filter((i) => myInterests.has(i));
  const union = new Set([...visibleInterests, ...myInterests]).size;
  const jaccard = union === 0 || visibleInterests.length === 0 ? 0 : shared.length / union;

  const sharedLanguages = (target.profile.languages ?? []).filter((l) => (viewerProfile?.languages ?? []).includes(l));
  const sameIntent = Boolean(
    showBio && target.profile.relationshipIntent && target.profile.relationshipIntent === viewerProfile?.relationshipIntent
  );

  // A rough indicator, not a promise: it only uses fields the other person
  // has chosen to show, so it can't be used to infer hidden ones.
  const score = Math.min(
    99,
    Math.round(42 + jaccard * 38 + Math.min(shared.length, 3) * 3 + (sharedLanguages.length ? 6 : 0) + (sameIntent ? 8 : 0))
  );

  const urls = await Promise.all(
    target.photos.map((p) => (full ? p.largeKey || p.mediumKey : p.mediumKey || p.thumbnailKey)).map((k) => (k ? getObjectUrl(k) : Promise.resolve("")))
  );
  const photos = urls.filter(Boolean);

  return {
    displayName: target.profile.displayName,
    age: showAge ? calculateAge(target.dateOfBirth) : null,
    location: showLocation ? settings?.locationLabel ?? null : null,
    bio: showBio ? target.profile.bio : null,
    interests: visibleInterests.slice(0, full ? 12 : 4).map((name) => ({ name, emoji: interestEmoji(name) })),
    photo: photos[0] ?? null,
    verified: target.verificationStatus === "VERIFIED",
    compatibility: { score, sharedInterests: shared, sharedLanguages, sameIntent },
    photos: full ? photos : photos.slice(0, 1),
    about: full && showBio
      ? {
          relationshipIntent: target.profile.relationshipIntent,
          education: target.profile.education,
          occupation: target.profile.occupation,
          languages: target.profile.languages,
        }
      : null,
  };
}
