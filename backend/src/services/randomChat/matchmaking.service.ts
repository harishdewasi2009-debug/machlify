import { Prisma } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { env } from "../../config/env";
import { Errors, ApiError } from "../../utils/apiError";
import { calculateAge } from "../../utils/age";
import { assertNotBanned, evaluateJoiner, joinLimiter, rateLimited, noteSkip, userNeedsChallenge, verifyChallenge, challengeRequired } from "./safety";
import { buildProfile } from "./card";
import { joinSessionRoom, leaveSessionRoom, toSession, toUser } from "./events";

// ---------------------------------------------------------------------------
// ELIGIBILITY
// ---------------------------------------------------------------------------
async function assertEligible(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { profile: true, randomChatSettings: true },
  });
  if (!user || user.status !== "ACTIVE") throw Errors.unauthorized();

  if (calculateAge(user.dateOfBirth) < env.MIN_AGE_YEARS) throw Errors.underMinimumAge(env.MIN_AGE_YEARS);
  if (env.REQUIRE_IDENTITY_VERIFICATION && user.verificationStatus !== "VERIFIED") {
    throw Errors.forbidden("Complete identity verification before using Random Chat.");
  }
  if (!user.profile?.displayName) throw Errors.validation("Finish setting up your profile before using Random Chat.");

  const photo = await prisma.photo.count({ where: { userId, status: "APPROVED" } });
  if (photo === 0) throw Errors.validation("Add at least one approved photo before using Random Chat.");

  const visibility = user.randomChatSettings?.visibility ?? "RANDOM_CHAT";
  if (visibility === "MATCH_ONLY" || visibility === "PRIVATE") {
    throw Errors.forbidden("Your profile visibility is set to Match Only / Private. Switch it to Public or Random Chat to use this feature.");
  }
  await assertNotBanned(userId);
  return user;
}

// ---------------------------------------------------------------------------
// STATE
// ---------------------------------------------------------------------------
export type RcState =
  | { state: "idle" }
  | { state: "waiting"; joinedAt: Date; timeoutSeconds: number }
  | { state: "chatting"; session: Awaited<ReturnType<typeof sessionView>> };

async function activeSessionFor(userId: string) {
  return prisma.randomChatSession.findFirst({
    where: { status: "ACTIVE", OR: [{ user1Id: userId }, { user2Id: userId }] },
    orderBy: { startedAt: "desc" },
  });
}

export async function getStatus(userId: string): Promise<RcState> {
  const session = await activeSessionFor(userId);
  if (session) return { state: "chatting", session: await sessionView(userId, session.id) };
  const q = await prisma.randomChatQueue.findUnique({ where: { userId } });
  if (q && q.status === "WAITING") return { state: "waiting", joinedAt: q.joinedAt, timeoutSeconds: env.RC_WAIT_TIMEOUT_SECONDS };
  return { state: "idle" };
}

// What a participant may see about a session. Contains NO user ids — the
// other person is identified only by the session, so profile/like/block/report
// are all addressed as "this session's partner".
export async function sessionView(userId: string, sessionId: string) {
  const s = await prisma.randomChatSession.findUnique({ where: { id: sessionId } });
  if (!s || (s.user1Id !== userId && s.user2Id !== userId)) throw Errors.notFound("Session");
  const partnerId = s.user1Id === userId ? s.user2Id : s.user1Id;

  const [card, presence, swipe, theirSwipe, match, messages] = await Promise.all([
    buildProfile(userId, partnerId, false),
    prisma.userPresence.findUnique({ where: { userId: partnerId } }),
    prisma.swipe.findUnique({ where: { actorId_targetId: { actorId: userId, targetId: partnerId } } }),
    prisma.swipe.findUnique({ where: { actorId_targetId: { actorId: partnerId, targetId: userId } } }),
    prisma.match.findUnique({ where: { userAId_userBId: userIdsOrdered(userId, partnerId) }, include: { conversation: true } }),
    prisma.randomChatMessage.findMany({ where: { sessionId }, orderBy: { createdAt: "asc" }, take: 200 }),
  ]);

  const matchActive = match && match.status === "ACTIVE" ? match : null;
  void theirSwipe; // deliberately NOT returned: a one-sided like stays private

  return {
    id: s.id,
    status: s.status,
    endReason: s.endReason,
    endedByMe: s.endedById === userId,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    partner: { ...card, online: Boolean(presence?.online) },
    iLiked: Boolean(swipe?.liked),
    matched: Boolean(matchActive),
    conversationId: matchActive?.conversation?.id ?? null,
    messages: messages.map((m) => toMessageDto(m, userId)),
  };
}

export function userIdsOrdered(a: string, b: string) {
  const [userAId, userBId] = [a, b].sort();
  return { userAId, userBId };
}

export function toMessageDto(
  m: { id: string; sessionId: string; senderId: string; clientId: string | null; content: string; deliveredAt: Date | null; readAt: Date | null; createdAt: Date },
  viewerId: string
) {
  return {
    id: m.id,
    sessionId: m.sessionId,
    clientId: m.clientId,
    mine: m.senderId === viewerId, // senderId itself is never sent
    content: m.content,
    deliveredAt: m.deliveredAt,
    readAt: m.readAt,
    createdAt: m.createdAt,
  };
}

// ---------------------------------------------------------------------------
// JOIN / LEAVE
// ---------------------------------------------------------------------------
export async function join(userId: string, opts: { socketId?: string | null; captchaToken?: string; ip?: string } = {}) {
  const wait = joinLimiter.take(userId);
  if (wait > 0) throw rateLimited(wait);

  const user = await assertEligible(userId);

  if (await userNeedsChallenge(userId)) {
    if (!(await verifyChallenge(opts.captchaToken, opts.ip))) throw challengeRequired();
  }

  const existing = await activeSessionFor(userId);
  if (existing) return getStatus(userId); // already chatting: never create a second concurrent session

  const hourly = await prisma.randomChatSession.count({
    where: { OR: [{ user1Id: userId }, { user2Id: userId }], startedAt: { gte: new Date(Date.now() - 3_600_000) } },
  });
  if (hourly >= env.RC_MAX_SESSIONS_PER_HOUR) {
    throw new ApiError(429, "RATE_LIMITED", "You've reached the hourly Random Chat limit. Please take a break and try again later.");
  }

  const [settings, interests] = await Promise.all([
    prisma.randomChatSettings.upsert({ where: { userId }, update: {}, create: { userId } }),
    prisma.userInterest.findMany({ where: { userId }, include: { interest: true } }),
  ]);

  const languages = settings.prefLanguages.length ? settings.prefLanguages : user.profile?.languages ?? [];
  const snapshot = {
    age: calculateAge(user.dateOfBirth),
    gender: user.gender,
    genderPreference: settings.prefGenders,
    minAge: Math.max(env.MIN_AGE_YEARS, settings.prefMinAge),
    maxAge: settings.prefMaxAge,
    languages,
    interests: settings.prefInterests.length ? settings.prefInterests : interests.map((i) => i.interest.name),
    sameRegion: settings.prefSameRegion && Boolean(settings.locationLabel),
    regionKey: settings.prefSameRegion && settings.locationLabel ? settings.locationLabel.trim().toLowerCase() : null,
    status: "WAITING" as const,
    joinedAt: new Date(),
    lastHeartbeat: new Date(),
    socketId: opts.socketId ?? null,
  };

  await prisma.randomChatQueue.upsert({ where: { userId }, update: snapshot, create: { userId, ...snapshot } });
  void evaluateJoiner(userId);

  await tryMatch(userId);
  return getStatus(userId);
}

export async function leave(userId: string) {
  await prisma.randomChatQueue.deleteMany({ where: { userId, status: "WAITING" } });
  return { state: "idle" as const };
}

export async function heartbeat(userId: string, socketId?: string) {
  await prisma.randomChatQueue.updateMany({
    where: { userId },
    data: { lastHeartbeat: new Date(), ...(socketId ? { socketId } : {}) },
  });
  const now = new Date();
  await prisma.randomChatSession.updateMany({ where: { status: "ACTIVE", user1Id: userId }, data: { user1SeenAt: now } });
  await prisma.randomChatSession.updateMany({ where: { status: "ACTIVE", user2Id: userId }, data: { user2SeenAt: now } });
}

// ---------------------------------------------------------------------------
// THE MATCHER
// ---------------------------------------------------------------------------
interface CandidateRow {
  userId: string;
  languages: string[];
  interests: string[];
  joinedAt: Date;
}

// Concurrency model (the "no two users get the same person" guarantee):
//   1. Everything runs in ONE transaction.
//   2. We lock our own queue row FOR UPDATE and re-check it is still WAITING.
//   3. Candidates are *ranked* from a plain read, then we try to lock the
//      best one with FOR UPDATE SKIP LOCKED + re-check WAITING. If another
//      transaction already holds/consumed that row, we simply skip to the
//      next candidate — nobody ever blocks or deadlocks, and a row can only
//      be flipped WAITING -> CHATTING by the single transaction that holds
//      its lock.
//   4. If we lose every race, we stay WAITING; the sweeper retries every few
//      seconds, so a lost race costs at most one tick.
export async function tryMatch(userId: string): Promise<string | null> {
  const result = await prisma.$transaction(
    async (tx) => {
      const mine = await tx.$queryRaw<
        { userId: string; age: number; gender: string; genderPreference: string[]; minAge: number; maxAge: number; languages: string[]; interests: string[]; sameRegion: boolean; regionKey: string | null }[]
      >(Prisma.sql`SELECT "userId", age, gender, "genderPreference", "minAge", "maxAge", languages, interests, "sameRegion", "regionKey"
                   FROM "RandomChatQueue" WHERE "userId" = ${userId} AND status = 'WAITING' FOR UPDATE`);
      const me = mine[0];
      if (!me) return null;

      const fresh = new Date(Date.now() - env.RC_QUEUE_FRESH_SECONDS * 1000);
      const cooldown = new Date(Date.now() - env.RC_REMATCH_COOLDOWN_MINUTES * 60_000);

      const candidates = await tx.$queryRaw<CandidateRow[]>(Prisma.sql`
        SELECT q."userId", q.languages, q.interests, q."joinedAt"
        FROM "RandomChatQueue" q
        JOIN "User" u ON u.id = q."userId" AND u.status = 'ACTIVE'
        WHERE q.status = 'WAITING'
          AND q."userId" <> ${userId}
          AND q."lastHeartbeat" >= ${fresh}
          AND q.age BETWEEN ${me.minAge}::int AND ${me.maxAge}::int
          AND ${me.age}::int BETWEEN q."minAge" AND q."maxAge"
          AND (cardinality(${me.genderPreference}::text[]) = 0 OR q.gender = ANY(${me.genderPreference}::text[]))
          AND (cardinality(q."genderPreference") = 0 OR ${me.gender}::text = ANY(q."genderPreference"))
          AND (${me.sameRegion}::boolean = false OR q."regionKey" = ${me.regionKey}::text)
          AND (q."sameRegion" = false OR q."regionKey" = ${me.regionKey}::text)
          AND NOT EXISTS (SELECT 1 FROM "Block" b WHERE (b."blockerId" = ${userId} AND b."blockedId" = q."userId") OR (b."blockerId" = q."userId" AND b."blockedId" = ${userId}))
          AND NOT EXISTS (SELECT 1 FROM "RandomChatBan" rb WHERE rb."userId" = q."userId" AND (rb."until" IS NULL OR rb."until" > now()))
          AND NOT EXISTS (
            SELECT 1 FROM "RandomChatSession" s
            WHERE ((s."user1Id" = ${userId} AND s."user2Id" = q."userId") OR (s."user1Id" = q."userId" AND s."user2Id" = ${userId}))
              AND (s.status = 'ACTIVE' OR s."startedAt" >= ${cooldown})
          )
        ORDER BY q."joinedAt" ASC
        LIMIT 40`);
      if (candidates.length === 0) return null;

      // Soft preferences rank candidates; they never exclude anyone.
      const myLang = new Set(me.languages);
      const myInt = new Set(me.interests);
      const ranked = candidates
        .map((c) => {
          const langHit = c.languages.some((l) => myLang.has(l)) ? 1 : 0;
          const shared = c.interests.filter((i) => myInt.has(i)).length;
          const waitedSec = (Date.now() - new Date(c.joinedAt).getTime()) / 1000;
          return { c, score: langHit * 10 + shared * 4 + Math.min(waitedSec / 10, 6) };
        })
        .sort((a, b) => b.score - a.score);

      for (const { c } of ranked) {
        const locked = await tx.$queryRaw<{ userId: string }[]>(
          Prisma.sql`SELECT "userId" FROM "RandomChatQueue" WHERE "userId" = ${c.userId} AND status = 'WAITING' FOR UPDATE SKIP LOCKED`
        );
        if (locked.length === 0) continue; // someone else got them first

        // Defense in depth against a race with an already-active session.
        const busy = await tx.randomChatSession.count({
          where: { status: "ACTIVE", OR: [{ user1Id: c.userId }, { user2Id: c.userId }, { user1Id: userId }, { user2Id: userId }] },
        });
        if (busy > 0) continue;

        const session = await tx.randomChatSession.create({ data: { user1Id: userId, user2Id: c.userId } });
        await tx.randomChatQueue.updateMany({ where: { userId: { in: [userId, c.userId] } }, data: { status: "CHATTING" } });
        return { sessionId: session.id, partnerId: c.userId };
      }
      return null;
    },
    { timeout: 10_000 }
  );

  if (!result) return null;
  await announceMatch(result.sessionId, userId, result.partnerId);
  return result.sessionId;
}

async function announceMatch(sessionId: string, a: string, b: string) {
  joinSessionRoom([a, b], sessionId);
  for (const uid of [a, b]) {
    try {
      const view = await sessionView(uid, sessionId);
      toUser(uid, "random_chat:matched", view);
    } catch {
      /* the client will pick the session up from /status on its next poll */
    }
  }
}

// ---------------------------------------------------------------------------
// ENDING / NEXT
// ---------------------------------------------------------------------------
export type EndReason = "ENDED" | "NEXT" | "BLOCKED" | "DISCONNECTED" | "ADMIN" | "REPORTED" | "ACCOUNT";

// Idempotent: the updateMany's `status: ACTIVE` guard means that when two
// ends race (A clicks Next as B's tab closes) exactly one wins and the other
// is a harmless no-op.
export async function endSession(sessionId: string, byUserId: string | null, reason: EndReason): Promise<boolean> {
  const ended = await prisma.$transaction(async (tx) => {
    const res = await tx.randomChatSession.updateMany({
      where: { id: sessionId, status: "ACTIVE" },
      data: { status: "ENDED", endedAt: new Date(), endedById: byUserId, endReason: reason },
    });
    if (res.count === 0) return null;
    const s = await tx.randomChatSession.findUniqueOrThrow({ where: { id: sessionId } });
    await tx.randomChatQueue.deleteMany({ where: { userId: { in: [s.user1Id, s.user2Id] }, status: "CHATTING" } });
    return s;
  });
  if (!ended) return false;

  for (const uid of [ended.user1Id, ended.user2Id]) {
    toUser(uid, "random_chat:ended", { sessionId, reason, byMe: uid === byUserId });
  }
  leaveSessionRoom(sessionId);
  return true;
}

export async function endByUser(userId: string, sessionId: string) {
  const s = await prisma.randomChatSession.findUnique({ where: { id: sessionId } });
  if (!s || (s.user1Id !== userId && s.user2Id !== userId)) throw Errors.notFound("Session");
  await endSession(sessionId, userId, "ENDED");
  return { ended: true };
}

export async function next(userId: string, opts: { sessionId?: string; socketId?: string | null; captchaToken?: string; ip?: string } = {}) {
  const wait = joinLimiter.take(userId);
  if (wait > 0) throw rateLimited(wait);
  noteSkip(userId);

  const s = opts.sessionId
    ? await prisma.randomChatSession.findUnique({ where: { id: opts.sessionId } })
    : await activeSessionFor(userId);
  if (s && (s.user1Id === userId || s.user2Id === userId) && s.status === "ACTIVE") {
    await endSession(s.id, userId, "NEXT");
  }
  // join() re-checks eligibility/bans, and the rematch cooldown in tryMatch
  // guarantees the person we just left is not handed straight back.
  return join(userId, { ...opts, captchaToken: opts.captchaToken });
}

// When a user's account is suspended/deleted, or they log out.
export async function cleanupUser(userId: string, reason: EndReason = "DISCONNECTED") {
  await prisma.randomChatQueue.deleteMany({ where: { userId, status: "WAITING" } });
  const active = await prisma.randomChatSession.findMany({
    where: { status: "ACTIVE", OR: [{ user1Id: userId }, { user2Id: userId }] },
    select: { id: true },
  });
  for (const s of active) await endSession(s.id, userId, reason);
}

export { toSession };
