import { prisma } from "../../config/prisma";
import { env } from "../../config/env";
import { Errors, ApiError } from "../../utils/apiError";
import { SlidingWindowLimiter } from "../../utils/randomChatFilter";

// ---- rate limiters (per user) --------------------------------------------
export const messageLimiter = new SlidingWindowLimiter(env.RC_MSG_BURST, env.RC_MSG_WINDOW_SECONDS * 1000);
export const joinLimiter = new SlidingWindowLimiter(12, 60_000); // 12 join/next actions per minute
export const skipLimiter = new SlidingWindowLimiter(15, 10 * 60_000); // "rapid skipping" detector, not a hard limit
const filteredLimiter = new SlidingWindowLimiter(5, 10 * 60_000);
const spamLimiter = new SlidingWindowLimiter(3, 10 * 60_000);

setInterval(() => {
  for (const l of [messageLimiter, joinLimiter, skipLimiter, filteredLimiter, spamLimiter]) l.prune();
}, 60_000).unref();

export function rateLimited(retryAfterMs: number): ApiError {
  return new ApiError(429, "RATE_LIMITED", `You're doing that too fast. Try again in ${Math.ceil(retryAfterMs / 1000)}s.`);
}

// ---- alerts ---------------------------------------------------------------
export async function raiseAlert(userId: string, type: string, detail?: string) {
  // One open alert per (user, type) per hour keeps the moderation queue readable.
  const since = new Date(Date.now() - 60 * 60_000);
  const existing = await prisma.randomChatAbuseAlert.findFirst({
    where: { userId, type, resolvedAt: null, createdAt: { gte: since } },
  });
  if (existing) return existing;
  return prisma.randomChatAbuseAlert.create({ data: { userId, type, detail } });
}

export function noteFilteredMessage(userId: string) {
  if (filteredLimiter.take(userId) > 0) void raiseAlert(userId, "BLOCKED_CONTENT", "Repeatedly tried to send contact details, links or sensitive info.");
}

export function noteSpamMessage(userId: string) {
  if (spamLimiter.take(userId) > 0) {
    void raiseAlert(userId, "MESSAGE_SPAM", "Repeated identical or flooding messages.");
  }
}

export function noteSkip(userId: string) {
  if (skipLimiter.take(userId) > 0) void raiseAlert(userId, "RAPID_SKIPPING", "More than 15 sessions skipped in 10 minutes.");
}

// ---- bans -----------------------------------------------------------------
export async function getActiveBan(userId: string) {
  const ban = await prisma.randomChatBan.findUnique({ where: { userId } });
  if (!ban) return null;
  if (ban.until && ban.until < new Date()) {
    await prisma.randomChatBan.delete({ where: { userId } }).catch(() => undefined);
    return null;
  }
  return ban;
}

export async function assertNotBanned(userId: string) {
  const ban = await getActiveBan(userId);
  if (ban) {
    const until = ban.until ? ` until ${ban.until.toISOString().slice(0, 16).replace("T", " ")} UTC` : "";
    throw new ApiError(403, "RANDOM_CHAT_BANNED", `Random Chat is unavailable for your account${until}.`);
  }
}

export async function applyBan(userId: string, reason: string, opts: { hours?: number; auto?: boolean; adminId?: string }) {
  const until = opts.hours ? new Date(Date.now() + opts.hours * 3_600_000) : null;
  return prisma.randomChatBan.upsert({
    where: { userId },
    update: { reason, until, auto: Boolean(opts.auto), createdBy: opts.adminId ?? null },
    create: { userId, reason, until, auto: Boolean(opts.auto), createdBy: opts.adminId ?? null },
  });
}

export async function liftBan(userId: string) {
  await prisma.randomChatBan.deleteMany({ where: { userId } });
}

// Called after every report against a user. Three different people reporting
// the same account inside a day is a strong enough signal to pause it
// automatically; a human still reviews it (the alert stays open).
export async function evaluateReportedUser(reportedId: string) {
  const since = new Date(Date.now() - 24 * 3_600_000);
  const rows = await prisma.report.findMany({
    where: { reportedId, createdAt: { gte: since } },
    select: { reporterId: true },
    distinct: ["reporterId"],
  });
  if (rows.length >= env.RC_AUTO_BAN_REPORTERS) {
    await applyBan(reportedId, `Reported by ${rows.length} different users in 24h`, { hours: env.RC_AUTO_BAN_HOURS, auto: true });
    await raiseAlert(reportedId, "MULTI_REPORT", `${rows.length} distinct reporters in 24h — temporarily paused, needs review.`);
    return true;
  }
  return false;
}

// Suspicious-account signals evaluated when a user joins the queue.
export async function evaluateJoiner(userId: string) {
  const [user, photos] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { createdAt: true } }),
    prisma.photo.findMany({ where: { userId, status: "APPROVED", contentHash: { not: null } }, select: { contentHash: true } }),
  ]);
  const hashes = photos.map((p) => p.contentHash!).filter(Boolean);
  if (hashes.length) {
    const dup = await prisma.photo.findFirst({
      where: { contentHash: { in: hashes }, userId: { not: userId }, status: "APPROVED", user: { status: "ACTIVE" } },
      select: { userId: true },
    });
    if (dup) await raiseAlert(userId, "DUPLICATE_PHOTO", "An approved photo is identical to one on another active account.");
  }
  if (user && Date.now() - user.createdAt.getTime() < 24 * 3_600_000) {
    const sessions = await prisma.randomChatSession.count({
      where: { OR: [{ user1Id: userId }, { user2Id: userId }], startedAt: { gte: new Date(Date.now() - 3_600_000) } },
    });
    if (sessions >= 15) await raiseAlert(userId, "NEW_ACCOUNT_BURST", "Account is <24h old and started 15+ chats in an hour.");
  }
}

// ---- CAPTCHA (optional) ---------------------------------------------------
export const captchaConfigured = Boolean(env.TURNSTILE_SECRET_KEY);

export async function userNeedsChallenge(userId: string): Promise<boolean> {
  if (!captchaConfigured) return false;
  const open = await prisma.randomChatAbuseAlert.count({
    where: { userId, resolvedAt: null, createdAt: { gte: new Date(Date.now() - 24 * 3_600_000) } },
  });
  return open > 0;
}

export async function verifyChallenge(token: string | undefined, ip?: string): Promise<boolean> {
  if (!captchaConfigured) return true;
  if (!token) return false;
  try {
    const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token });
    if (ip) body.set("remoteip", ip);
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
    const json = (await res.json()) as { success?: boolean };
    return Boolean(json.success);
  } catch {
    return false; // fail closed: a challenge we can't verify isn't passed
  }
}

export function challengeRequired(): ApiError {
  return new ApiError(428, "CHALLENGE_REQUIRED", "Please complete the verification challenge to continue.");
}

export { Errors };
