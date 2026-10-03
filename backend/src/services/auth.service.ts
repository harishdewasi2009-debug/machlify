import { prisma } from "../config/prisma";
import { env, emailConfigured } from "../config/env";
import { Errors } from "../utils/apiError";
import { calculateAge } from "../utils/age";
import { hashPassword, isPasswordStrongEnough, verifyPassword } from "../utils/password";
import {
  addDays,
  addMinutes,
  generateOpaqueToken,
  hashOpaqueToken,
  signAccessToken,
} from "../utils/tokens";
import { sendAccountDeletionEmail, sendPasswordResetEmail, sendVerificationEmail } from "./email.service";
import { verifyGoogleIdToken } from "./google.service";
import { verifyAppleIdToken } from "./apple.service";
import { cancelSubscription } from "./subscription.service";

// Shared by both login paths. PENDING_DELETION gets its own error (and its
// own recovery path — the emailed restore link, not logging back in) rather
// than being lumped in with SUSPENDED, which has no self-service recovery.
function assertLoginable(user: { status: string }) {
  if (user.status === "PENDING_DELETION") throw Errors.accountPendingDeletion();
  if (user.status !== "ACTIVE") throw Errors.accountSuspended();
}

interface RegisterInput {
  name: string;
  email: string;
  password: string;
  dateOfBirth: Date;
  gender: string;
}

export async function registerUser(input: RegisterInput) {
  const age = calculateAge(input.dateOfBirth);
  if (age < env.MIN_AGE_YEARS) {
    throw Errors.underMinimumAge(env.MIN_AGE_YEARS);
  }

  if (!isPasswordStrongEnough(input.password)) {
    throw Errors.validation("Password must be at least 10 characters and include a letter and a number.");
  }

  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) {
    // Same response shape as "check your email" below would give — avoid
    // confirming account existence to an anonymous caller is a reasonable
    // hardening step, but for this MVP we surface it explicitly per the spec.
    throw Errors.emailInUse();
  }

  const passwordHash = await hashPassword(input.password);

  const user = await prisma.user.create({
    data: {
      email: input.email,
      passwordHash,
      dateOfBirth: input.dateOfBirth,
      gender: input.gender,
      provider: "PASSWORD",
      profile: { create: { displayName: input.name } },
      preferences: { create: {} },
    },
  });

  const { raw, hash } = generateOpaqueToken();
  await prisma.emailVerificationToken.create({
    data: { userId: user.id, tokenHash: hash, expiresAt: addDays(new Date(), 1) },
  });

  // A failed verification email must not fail sign-up (the account already exists).
  // With no SMTP configured there is no way to verify, so mark the email verified
  // instead of leaving the user stuck.
  if (!emailConfigured) {
    console.warn("[auth] SMTP not configured: marking email as verified for", user.email);
    await prisma.user.update({ where: { id: user.id }, data: { emailVerified: true } });
  } else {
    try {
      await sendVerificationEmail(user.email, raw, env.APP_ORIGIN);
    } catch (err) {
      console.error("[auth] Could not send verification email:", err);
    }
  }

  return { id: user.id, email: user.email };
}

export async function verifyEmailToken(rawToken: string) {
  const tokenHash = hashOpaqueToken(rawToken);
  const record = await prisma.emailVerificationToken.findUnique({ where: { tokenHash } });

  if (!record || record.usedAt || record.expiresAt < new Date()) {
    throw Errors.invalidToken();
  }

  await prisma.$transaction([
    prisma.emailVerificationToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
    prisma.user.update({ where: { id: record.userId }, data: { emailVerified: true } }),
  ]);
}

interface DeviceContext {
  userAgent?: string;
  ipAddress?: string;
}

async function createSessionForUser(userId: string, ctx: DeviceContext) {
  const session = await prisma.session.create({
    data: {
      userId,
      userAgent: ctx.userAgent,
      ipAddress: ctx.ipAddress,
      expiresAt: addDays(new Date(), env.REFRESH_TOKEN_TTL_DAYS),
    },
  });

  const accessToken = signAccessToken({ sub: userId, sessionId: session.id });

  const { raw: refreshTokenRaw, hash: refreshTokenHash } = generateOpaqueToken();
  await prisma.refreshToken.create({
    data: {
      tokenHash: refreshTokenHash,
      userId,
      sessionId: session.id,
      expiresAt: addDays(new Date(), env.REFRESH_TOKEN_TTL_DAYS),
    },
  });

  return { accessToken, refreshTokenRaw, sessionId: session.id };
}

export async function loginWithPassword(email: string, password: string, ctx: DeviceContext) {
  const user = await prisma.user.findUnique({ where: { email } });

  // Constant-shape error whether the account exists or the password is
  // wrong, so login can't be used to enumerate registered emails.
  if (!user || !user.passwordHash) {
    throw Errors.invalidCredentials();
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw Errors.accountLocked();
  }

  assertLoginable(user);

  const valid = await verifyPassword(password, user.passwordHash);

  if (!valid) {
    const attempts = user.failedLoginAttempts + 1;
    const shouldLock = attempts >= env.ACCOUNT_LOCK_THRESHOLD;
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginAttempts: shouldLock ? 0 : attempts,
        lockedUntil: shouldLock ? addMinutes(new Date(), env.ACCOUNT_LOCK_MINUTES) : null,
      },
    });
    throw Errors.invalidCredentials();
  }

  await prisma.user.update({ where: { id: user.id }, data: { failedLoginAttempts: 0, lockedUntil: null } });

  return { user, ...(await createSessionForUser(user.id, ctx)) };
}

export async function loginWithGoogle(idToken: string, ctx: DeviceContext) {
  const identity = await verifyGoogleIdToken(idToken);

  let user = await prisma.user.findUnique({ where: { googleId: identity.googleId } });

  if (!user) {
    // If an account already exists with this email via password signup,
    // link the Google identity to it rather than creating a duplicate user.
    user = await prisma.user.findUnique({ where: { email: identity.email } });
    if (user) {
      user = await prisma.user.update({ where: { id: user.id }, data: { googleId: identity.googleId } });
    }
  }

  if (!user) {
    // New Google sign-ups still need DOB + gender collected via a follow-up
    // onboarding step before they can access matching — Google doesn't give
    // us date of birth, so age can't be enforced from this alone.
    throw Errors.validation(
      "No account found for this Google identity. Complete registration with date of birth first."
    );
  }

  assertLoginable(user);

  if (!user.emailVerified && identity.emailVerified) {
    user = await prisma.user.update({ where: { id: user.id }, data: { emailVerified: true } });
  }

  return { user, ...(await createSessionForUser(user.id, ctx)) };
}

// New account created from a verified Google identity. The ID token is
// verified with Google (never a bare email from the client), the age check is
// the same server-side one password sign-up uses, and Google's own
// email_verified claim decides emailVerified — so no verification email (or
// email provider) is needed for these accounts.
export async function registerWithGoogle(
  input: { idToken: string; name: string; dateOfBirth: Date; gender: string },
  ctx: DeviceContext
) {
  const identity = await verifyGoogleIdToken(input.idToken);

  if (calculateAge(input.dateOfBirth) < env.MIN_AGE_YEARS) {
    throw Errors.underMinimumAge(env.MIN_AGE_YEARS);
  }

  const existing = await prisma.user.findFirst({
    where: { OR: [{ googleId: identity.googleId }, { email: identity.email }] },
  });
  if (existing) throw Errors.emailInUse();

  const user = await prisma.user.create({
    data: {
      email: identity.email,
      googleId: identity.googleId,
      emailVerified: identity.emailVerified,
      dateOfBirth: input.dateOfBirth,
      gender: input.gender,
      provider: "GOOGLE",
      profile: { create: { displayName: input.name } },
      preferences: { create: {} },
    },
  });

  return { user, ...(await createSessionForUser(user.id, ctx)) };
}

export async function loginWithApple(idToken: string, ctx: DeviceContext) {
  const identity = await verifyAppleIdToken(idToken);

  let user = await prisma.user.findUnique({ where: { appleId: identity.appleId } });
  if (!user) {
    user = await prisma.user.findUnique({ where: { email: identity.email } });
    if (user) user = await prisma.user.update({ where: { id: user.id }, data: { appleId: identity.appleId } });
  }
  if (!user) {
    throw Errors.validation("No account found for this Apple identity. Complete registration with date of birth first.");
  }

  assertLoginable(user);
  if (!user.emailVerified && identity.emailVerified) {
    user = await prisma.user.update({ where: { id: user.id }, data: { emailVerified: true } });
  }
  return { user, ...(await createSessionForUser(user.id, ctx)) };
}

export async function registerWithApple(
  input: { idToken: string; name: string; dateOfBirth: Date; gender: string },
  ctx: DeviceContext
) {
  const identity = await verifyAppleIdToken(input.idToken);

  if (calculateAge(input.dateOfBirth) < env.MIN_AGE_YEARS) {
    throw Errors.underMinimumAge(env.MIN_AGE_YEARS);
  }
  const existing = await prisma.user.findFirst({
    where: { OR: [{ appleId: identity.appleId }, { email: identity.email }] },
  });
  if (existing) throw Errors.emailInUse();

  const user = await prisma.user.create({
    data: {
      email: identity.email,
      appleId: identity.appleId,
      emailVerified: identity.emailVerified,
      dateOfBirth: input.dateOfBirth,
      gender: input.gender,
      provider: "APPLE",
      profile: { create: { displayName: input.name } },
      preferences: { create: {} },
    },
  });
  return { user, ...(await createSessionForUser(user.id, ctx)) };
}

export async function refreshSession(rawRefreshToken: string, ctx: DeviceContext) {
  const tokenHash = hashOpaqueToken(rawRefreshToken);
  const record = await prisma.refreshToken.findUnique({ where: { tokenHash } });

  if (!record || record.revoked || record.expiresAt < new Date()) {
    throw Errors.unauthorized();
  }

  // Rotate: revoke the used token and issue a new one. If a revoked token is
  // ever presented again, that's a signal of token theft/replay.
  await prisma.refreshToken.update({ where: { id: record.id }, data: { revoked: true } });

  const session = await prisma.session.findUnique({ where: { id: record.sessionId } });
  if (!session || session.revoked || session.expiresAt < new Date()) {
    throw Errors.unauthorized();
  }

  const accessToken = signAccessToken({ sub: record.userId, sessionId: session.id });
  const { raw: refreshTokenRaw, hash: refreshTokenHash } = generateOpaqueToken();

  await prisma.refreshToken.create({
    data: {
      tokenHash: refreshTokenHash,
      userId: record.userId,
      sessionId: session.id,
      expiresAt: addDays(new Date(), env.REFRESH_TOKEN_TTL_DAYS),
    },
  });

  return { accessToken, refreshTokenRaw };
}

export async function logout(sessionId: string) {
  await prisma.session.update({ where: { id: sessionId }, data: { revoked: true } });
  await prisma.refreshToken.updateMany({ where: { sessionId }, data: { revoked: true } });
}

export async function logoutAllDevices(userId: string) {
  await prisma.session.updateMany({ where: { userId }, data: { revoked: true } });
  await prisma.refreshToken.updateMany({ where: { userId }, data: { revoked: true } });
}

export async function requestPasswordReset(email: string) {
  const user = await prisma.user.findUnique({ where: { email } });
  // Always behave the same way whether or not the account exists, so this
  // endpoint can't be used to check which emails are registered.
  if (!user || !user.passwordHash) return;

  const { raw, hash } = generateOpaqueToken();
  await prisma.passwordResetToken.create({
    data: { userId: user.id, tokenHash: hash, expiresAt: addMinutes(new Date(), 60) },
  });

  await sendPasswordResetEmail(user.email, raw, env.APP_ORIGIN);
}

export async function resetPassword(rawToken: string, newPassword: string) {
  if (!isPasswordStrongEnough(newPassword)) {
    throw Errors.validation("Password must be at least 10 characters and include a letter and a number.");
  }

  const tokenHash = hashOpaqueToken(rawToken);
  const record = await prisma.passwordResetToken.findUnique({ where: { tokenHash } });

  if (!record || record.usedAt || record.expiresAt < new Date()) {
    throw Errors.invalidToken();
  }

  const passwordHash = await hashPassword(newPassword);

  await prisma.$transaction([
    prisma.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
    prisma.user.update({ where: { id: record.userId }, data: { passwordHash } }),
  ]);

  // Resetting the password invalidates every existing session — a stolen
  // session shouldn't survive a legitimate password reset.
  await logoutAllDevices(record.userId);
}

interface DeletionRequestResult {
  scheduledDeletionAt: Date;
  emailSent: boolean;
}

// Requesting deletion takes effect immediately: login is disabled right
// away (assertLoginable above rejects PENDING_DELETION), every existing
// session/refresh token is revoked, the profile disappears from discovery,
// and active matches are closed on both sides — none of that waits for the
// grace period to elapse. The grace period only controls when the
// *permanent* anonymization/erasure runs (see scripts/purgeDeletedAccounts.ts),
// giving the user a window to change their mind via the emailed restore
// link rather than by logging back in.
export async function requestAccountDeletion(userId: string, password?: string): Promise<DeletionRequestResult> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw Errors.notFound("User");
  if (user.status !== "ACTIVE") throw Errors.validation("This account is already scheduled for deletion.");

  // If the account has a password, require it again here as defense in
  // depth — a hijacked session token alone shouldn't be enough to destroy
  // the account. Google-only accounts have no password to check; the
  // active session is all we can require for those.
  if (user.passwordHash) {
    if (!password) throw Errors.validation("Enter your password to confirm account deletion.");
    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) throw Errors.invalidCredentials();
  }

  const scheduledDeletionAt = addDays(new Date(), env.ACCOUNT_DELETION_GRACE_DAYS);

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: { status: "PENDING_DELETION", scheduledDeletionAt },
    });

    await tx.profile.updateMany({ where: { userId }, data: { isDiscoverable: false } });

    // Close (not delete) any active match — this is the same status field
    // match.service/chat.service already check, so both users immediately
    // stop seeing this as an active match/conversation, and further
    // messages are rejected, without touching message history.
    await tx.match.updateMany({
      where: { OR: [{ userAId: userId }, { userBId: userId }], status: "ACTIVE" },
      data: { status: "ACCOUNT_DELETED" },
    });
  });

  // Revoke everywhere — this is what actually "disables login": there is no
  // valid session/refresh token left, and assertLoginable also blocks a
  // fresh login attempt regardless.
  await logoutAllDevices(userId);

  // Best-effort: don't renew, but a subscription's already-paid access
  // still lapses naturally via endDate, same as any other cancellation.
  try {
    await cancelSubscription(userId);
  } catch {
    // No active subscription to cancel — not an error for this flow.
  }

  const { raw, hash } = generateOpaqueToken();
  await prisma.accountDeletionToken.create({
    data: { userId, tokenHash: hash, expiresAt: scheduledDeletionAt },
  });

  // Sending the confirmation/restore email is best-effort: an unconfigured
  // mail provider must never block the deletion itself (sessions are
  // already revoked above), but the caller is told whether it went out so
  // the frontend can show "you won't get a restore link" if not.
  let emailSent = true;
  try {
    await sendAccountDeletionEmail(user.email, raw, env.APP_ORIGIN, scheduledDeletionAt);
  } catch {
    emailSent = false;
  }

  return { scheduledDeletionAt, emailSent };
}

// The only self-service way back from PENDING_DELETION. Deliberately not
// "log in and cancel" — login stays disabled the whole time a deletion is
// pending (see assertLoginable) — so a stolen session alone can't be used
// to both request deletion and later "prove" it was legitimate; only
// possession of the emailed link can undo it.
export async function restoreAccount(rawToken: string): Promise<void> {
  const tokenHash = hashOpaqueToken(rawToken);
  const record = await prisma.accountDeletionToken.findUnique({ where: { tokenHash } });

  if (!record || record.usedAt || record.expiresAt < new Date()) {
    throw Errors.invalidToken();
  }

  const user = await prisma.user.findUnique({ where: { id: record.userId } });
  // Already purged (grace period elapsed) or already restored some other
  // way — either way this token can no longer do anything useful.
  if (!user || user.status !== "PENDING_DELETION") {
    throw Errors.invalidToken();
  }

  await prisma.$transaction([
    prisma.accountDeletionToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
    prisma.user.update({
      where: { id: user.id },
      data: { status: "ACTIVE", scheduledDeletionAt: null },
    }),
  ]);

  // Restoring the account doesn't restore the old (revoked) sessions or the
  // matches that were closed — the user logs in fresh and reconnects with
  // matches organically, same as any other returning user.
}

export async function changePassword(userId: string, currentPassword: string, newPassword: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !user.passwordHash) throw Errors.notFound("User");

  const valid = await verifyPassword(currentPassword, user.passwordHash);
  if (!valid) throw Errors.invalidCredentials();

  if (!isPasswordStrongEnough(newPassword)) {
    throw Errors.validation("Password must be at least 10 characters and include a letter and a number.");
  }

  const passwordHash = await hashPassword(newPassword);
  await prisma.user.update({ where: { id: userId }, data: { passwordHash } });
}
