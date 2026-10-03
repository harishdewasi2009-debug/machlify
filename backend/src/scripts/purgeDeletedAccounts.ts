// Permanently anonymizes any account still PENDING_DELETION once its grace
// period (User.scheduledDeletionAt, set by POST /api/auth/account) has
// elapsed. Intended to run on a schedule (cron / hosting scheduler — there
// is no in-process job queue yet, see README "Background jobs"), not on
// every request:
//
//   npm run account:purge
//   # e.g. as a daily cron: 0 3 * * * cd /app && npm run account:purge
//
// What this does NOT delete, per the retention policy (README "Account
// deletion"): Payment/Subscription rows (financial records), Match/Message/
// Report/Block rows (the other party's history and safety records), and
// VerificationSession/VerificationEvent rows (compliance audit trail). The
// user's own row is anonymized, never dropped, so those foreign keys stay
// valid and the other side of a conversation still resolves to a "Deleted
// user" profile instead of a broken reference.
import { prisma } from "../config/prisma";
import { deleteObject } from "../services/storage.service";

async function purgeUser(userId: string): Promise<void> {
  const photos = await prisma.photo.findMany({ where: { userId } });

  await Promise.all(
    photos.flatMap((photo) =>
      [photo.storageKey, photo.largeKey, photo.mediumKey, photo.thumbnailKey]
        .filter((key): key is string => Boolean(key))
        .map((key) =>
          deleteObject(key).catch((err) => {
            // Best-effort: an already-missing object or a storage hiccup
            // shouldn't abort the rest of this user's purge. The DB rows
            // below are deleted regardless, so a leftover orphaned object
            // is the worst case, not a stuck account.
            console.error(`purge: failed to delete storage object ${key} for user ${userId}:`, err);
          })
        )
    )
  );

  await prisma.$transaction([
    prisma.photo.deleteMany({ where: { userId } }),
    prisma.userInterest.deleteMany({ where: { userId } }),
    prisma.preference.deleteMany({ where: { userId } }),
    prisma.device.deleteMany({ where: { userId } }), // push subscriptions
    prisma.notification.deleteMany({ where: { userId } }),
    prisma.notificationPreference.deleteMany({ where: { userId } }),
    prisma.session.deleteMany({ where: { userId } }),
    prisma.refreshToken.deleteMany({ where: { userId } }),
    prisma.emailVerificationToken.deleteMany({ where: { userId } }),
    prisma.passwordResetToken.deleteMany({ where: { userId } }),
    prisma.accountDeletionToken.deleteMany({ where: { userId } }),
    prisma.profile.updateMany({
      where: { userId },
      data: {
        displayName: "Deleted user",
        bio: null,
        education: null,
        occupation: null,
        languages: [],
        relationshipIntent: null,
        latitude: null,
        longitude: null,
        isDiscoverable: false,
      },
    }),
    prisma.user.update({
      where: { id: userId },
      data: {
        // Frees the original email up for re-registration. Guaranteed
        // unique and obviously not a deliverable address.
        email: `deleted-${userId}@deleted.matchify.invalid`,
        passwordHash: null,
        googleId: null,
        appleId: null,
        status: "DELETED",
        deletedAt: new Date(),
        scheduledDeletionAt: null,
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    }),
  ]);
}

async function main() {
  const due = await prisma.user.findMany({
    where: { status: "PENDING_DELETION", scheduledDeletionAt: { lte: new Date() } },
    select: { id: true, email: true },
  });

  if (due.length === 0) {
    console.log("purge: nothing due.");
    return;
  }

  console.log(`purge: ${due.length} account(s) due for permanent deletion.`);

  for (const user of due) {
    try {
      await purgeUser(user.id);
      console.log(`purge: completed for user ${user.id}.`);
    } catch (err) {
      // One user's failure shouldn't stop the rest of the batch — it stays
      // PENDING_DELETION and gets retried on the next scheduled run.
      console.error(`purge: failed for user ${user.id}, will retry next run:`, err);
    }
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
