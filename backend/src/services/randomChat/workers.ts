import { prisma } from "../../config/prisma";
import { env } from "../../config/env";
import { endSession, tryMatch } from "./matchmaking.service";
import { toUser } from "./events";

// Background jobs. Every tick takes a Postgres advisory lock first, so when
// the backend runs as several instances only one of them does the sweep at a
// time — no duplicate work and no double-ending of sessions.
const LOCK_KEY = 7270001;
let timer: NodeJS.Timeout | null = null;
let ticks = 0;

async function withLeaderLock(fn: () => Promise<void>) {
  await prisma.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(${LOCK_KEY}) AS locked`;
      if (!rows[0]?.locked) return;
      await fn();
    },
    { timeout: 30_000 }
  );
}

async function sweep() {
  const now = Date.now();

  // 1) Queue rows nobody is heartbeating for (closed tab, dead connection,
  //    logged out) — dropped so no one is stuck "waiting" forever and no live
  //    user is ever matched to a ghost.
  await prisma.randomChatQueue.deleteMany({
    where: { status: "WAITING", lastHeartbeat: { lt: new Date(now - env.RC_QUEUE_STALE_SECONDS * 1000) } },
  });
  // CHATTING rows whose session has already ended are leftovers.
  await prisma.$executeRaw`DELETE FROM "RandomChatQueue" q WHERE q.status IN ('CHATTING','MATCHED')
    AND NOT EXISTS (SELECT 1 FROM "RandomChatSession" s WHERE s.status='ACTIVE' AND (s."user1Id"=q."userId" OR s."user2Id"=q."userId"))`;

  // 2) Waiting too long: tell the user honestly that nobody is available.
  const expired = await prisma.randomChatQueue.findMany({
    where: { status: "WAITING", joinedAt: { lt: new Date(now - env.RC_WAIT_TIMEOUT_SECONDS * 1000) } },
    select: { userId: true },
  });
  if (expired.length) {
    await prisma.randomChatQueue.deleteMany({ where: { userId: { in: expired.map((e) => e.userId) }, status: "WAITING" } });
    for (const e of expired) toUser(e.userId, "random_chat:timeout", { message: "Not enough people are available right now. Try again in a few minutes." });
  }

  // 3) Sessions where a participant went silent.
  const stale = new Date(now - env.RC_SESSION_STALE_SECONDS * 1000);
  // A background tab's timers are throttled by browsers, so silence alone is
  // not enough: a participant only counts as gone if they ALSO have no live
  // socket (UserPresence.online is false) — Socket.IO's own ping/pong keeps
  // that accurate even when the tab is hidden.
  const candidates = await prisma.randomChatSession.findMany({
    where: { status: "ACTIVE", OR: [{ user1SeenAt: { lt: stale } }, { user2SeenAt: { lt: stale } }] },
    select: { id: true, user1Id: true, user2Id: true, user1SeenAt: true, user2SeenAt: true },
  });
  for (const s of candidates) {
    const silentIds = [s.user1SeenAt < stale ? s.user1Id : null, s.user2SeenAt < stale ? s.user2Id : null].filter(Boolean) as string[];
    const online = await prisma.userPresence.findMany({ where: { userId: { in: silentIds }, online: true }, select: { userId: true } });
    const reallyGone = silentIds.filter((id) => !online.some((o) => o.userId === id));
    if (reallyGone.length) await endSession(s.id, reallyGone[0], "DISCONNECTED");
  }

  // 4) Retry matching for everyone still waiting (covers lost lock races and
  //    people who became compatible after joining, e.g. someone new arrived).
  const waiting = await prisma.randomChatQueue.findMany({
    where: { status: "WAITING" },
    orderBy: { joinedAt: "asc" },
    select: { userId: true },
    take: 500,
  });
  for (const w of waiting) {
    try {
      await tryMatch(w.userId);
    } catch (err) {
      console.error("random-chat tryMatch failed", err);
    }
  }

  // 5) Hourly housekeeping.
  if (ticks % 720 === 0) {
    const cutoff = new Date(now - env.RC_MESSAGE_RETENTION_DAYS * 86_400_000);
    await prisma.randomChatMessage.deleteMany({
      where: { createdAt: { lt: cutoff }, session: { status: "ENDED" } },
    });
    await prisma.userPresence.updateMany({ where: { online: true, lastSeenAt: { lt: new Date(now - 6 * 3_600_000) } }, data: { online: false } });
    await prisma.randomChatBan.deleteMany({ where: { until: { lt: new Date(now) } } });
  }
}

export function startRandomChatWorkers() {
  if (timer) return;
  // Boot recovery: nobody is really connected after a restart, so presence is
  // reset; sessions/queue rows then expire via heartbeat as clients reconnect.
  void prisma.userPresence.updateMany({ where: { online: true }, data: { online: false } }).catch(() => undefined);

  timer = setInterval(() => {
    ticks++;
    withLeaderLock(sweep).catch((err) => console.error("random-chat sweep failed", err));
  }, 5000);
  timer.unref();
}

export function stopRandomChatWorkers() {
  if (timer) clearInterval(timer);
  timer = null;
}
