// Creates (or refreshes) a ready-to-use DEMO user and a demo admin (plus,
// only when SEED_DEMO_PROFILES=true, a few fake profiles to swipe on). Safe to run on every deploy: everything is an
// upsert keyed by email, so nothing is duplicated.
//
// Demo user:  demo@matchify.app  /  Demo@12345
// Demo admin: demoadmin@matchify.app  /  DemoAdmin@12345
//
// Override with DEMO_EMAIL / DEMO_PASSWORD / DEMO_ADMIN_EMAIL /
// DEMO_ADMIN_PASSWORD / DEMO_ADMIN_ROLE. Disable entirely with SEED_DEMO=false.
//
// SECURITY: in production (NODE_ENV=production) the demo ADMIN is NOT created with the
// password published in DEMO_ACCOUNT.md — an admin account with a public password on an
// internet-facing server would give anyone access to every user's data. There it is only
// created when you set DEMO_ADMIN_PASSWORD yourself (12+ chars), and it gets the MODERATOR
// role unless you set DEMO_ADMIN_ROLE=ADMIN. If DEMO_ADMIN_PASSWORD is not set in production,
// any demo admin left over from an earlier deploy is disabled.
//
// Runs automatically every time the server starts (see server.ts), or
// manually: npm run demo:seed
import { prisma } from "../config/prisma";
import { randomBytes } from "node:crypto";
import { hashPassword, isPasswordStrongEnough } from "../utils/password";

const DEMO_EMAIL = process.env.DEMO_EMAIL ?? "demo@matchify.app";
const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "Demo@12345";
const DEMO_ADMIN_EMAIL = process.env.DEMO_ADMIN_EMAIL ?? "demoadmin@matchify.app";
const IS_PRODUCTION = process.env.NODE_ENV === "production";
// Local/dev keeps the documented password; production must supply its own (see header).
const DEMO_ADMIN_PASSWORD = process.env.DEMO_ADMIN_PASSWORD ?? (IS_PRODUCTION ? "" : "DemoAdmin@12345");
const DEMO_ADMIN_ROLE = process.env.DEMO_ADMIN_ROLE === "ADMIN" || process.env.DEMO_ADMIN_ROLE === "MODERATOR"
  ? process.env.DEMO_ADMIN_ROLE
  : IS_PRODUCTION
    ? "MODERATOR"
    : "ADMIN";

// Mumbai — every demo profile is placed within a few km so discovery's
// distance filter always finds them.
const BASE_LAT = 19.076;
const BASE_LON = 72.8777;

function dobForAge(age: number): Date {
  const d = new Date();
  d.setFullYear(d.getFullYear() - age);
  d.setMonth(5, 15);
  d.setHours(0, 0, 0, 0);
  return d;
}

interface DemoPerson {
  email: string;
  name: string;
  age: number;
  gender: string;
  bio: string;
  occupation: string;
}

const DEMO_USER: DemoPerson = {
  email: DEMO_EMAIL,
  name: "Demo User",
  age: 26,
  gender: "MAN",
  bio: "This is a demo account. Feel free to look around!",
  occupation: "Product Designer",
};

const DEMO_CANDIDATES: DemoPerson[] = [
  { email: "demo.aanya@matchify.app", name: "Aanya", age: 25, gender: "WOMAN", bio: "Chai over coffee, always.", occupation: "Designer" },
  { email: "demo.diya@matchify.app", name: "Diya", age: 27, gender: "WOMAN", bio: "Weekend hiker, weekday overthinker.", occupation: "Software Engineer" },
  { email: "demo.meera@matchify.app", name: "Meera", age: 24, gender: "WOMAN", bio: "Bookstore wanderer and amateur chef.", occupation: "Writer" },
  { email: "demo.kavya@matchify.app", name: "Kavya", age: 28, gender: "WOMAN", bio: "Dog person. Playlist curator.", occupation: "Photographer" },
  { email: "demo.riya@matchify.app", name: "Riya", age: 26, gender: "WOMAN", bio: "Here for good conversations and better memes.", occupation: "Doctor" },
];

async function upsertPerson(
  person: DemoPerson,
  passwordHash: string,
  index: number,
  interestedIn: string[]
) {
  const user = await prisma.user.upsert({
    where: { email: person.email },
    update: { passwordHash, status: "ACTIVE", emailVerified: true, verificationStatus: "VERIFIED", failedLoginAttempts: 0, lockedUntil: null },
    create: {
      email: person.email,
      passwordHash,
      provider: "PASSWORD",
      emailVerified: true,
      verificationStatus: "VERIFIED",
      status: "ACTIVE",
      dateOfBirth: dobForAge(person.age),
      gender: person.gender,
    },
  });

  // Small deterministic offset so the profiles aren't all on one pin.
  const latitude = BASE_LAT + index * 0.004;
  const longitude = BASE_LON + index * 0.004;

  await prisma.profile.upsert({
    where: { userId: user.id },
    update: {},
    create: {
      userId: user.id,
      displayName: person.name,
      bio: person.bio,
      occupation: person.occupation,
      latitude,
      longitude,
      languages: ["English", "Hindi"],
      isDiscoverable: true,
    },
  });

  await prisma.preference.upsert({
    where: { userId: user.id },
    update: { genders: interestedIn, minAge: 18, maxAge: 99, maxDistanceKm: 100 },
    create: { userId: user.id, genders: interestedIn, minAge: 18, maxAge: 99, maxDistanceKm: 100 },
  });

  // Discovery only shows people with an APPROVED photo. These are
  // placeholder rows (no real file in storage), so the card shows no image
  // — upload a real photo from the app if you want one.
  const hasPhoto = await prisma.photo.count({ where: { userId: user.id } });
  if (hasPhoto === 0) {
    await prisma.photo.create({
      data: { userId: user.id, storageKey: `demo/${user.id}.jpg`, status: "APPROVED", isPrimary: true, position: 0 },
    });
  }

  return user;
}

export async function seedDemo(): Promise<void> {
  if (process.env.SEED_DEMO === "false") {
    console.log("SEED_DEMO=false — skipping demo seed.");
    return;
  }

  const userHash = await hashPassword(DEMO_PASSWORD);

  // The demo user is a man looking for women; the demo profiles are women
  // looking for men, so they appear in each other's discovery deck.
  await upsertPerson(DEMO_USER, userHash, 0, ["WOMAN"]);

  // Fake swipe-able profiles are OFF by default so real users only ever see
  // real people on the front page. Opt in with SEED_DEMO_PROFILES=true.
  const demoEmails = DEMO_CANDIDATES.map((c) => c.email);
  if (process.env.SEED_DEMO_PROFILES === "true") {
    for (let i = 0; i < DEMO_CANDIDATES.length; i++) {
      await upsertPerson(DEMO_CANDIDATES[i], userHash, i + 1, ["MAN"]);
    }
  } else {
    // Hide any fake profiles left over from earlier deploys.
    await prisma.profile.updateMany({
      where: { user: { email: { in: demoEmails } } },
      data: { isDiscoverable: false },
    });
  }

  const adminOk = await seedDemoAdmin();

  console.log(
    `Demo ready -> user: ${DEMO_EMAIL}${IS_PRODUCTION ? "" : ` / ${DEMO_PASSWORD}`}` +
      (adminOk ? ` | admin: ${DEMO_ADMIN_EMAIL}${IS_PRODUCTION ? ` (role ${DEMO_ADMIN_ROLE}, password from DEMO_ADMIN_PASSWORD)` : ` / ${DEMO_ADMIN_PASSWORD}`}` : " | demo admin: disabled")
  );
}

// Makes the demo admin usable (or, in production without an explicit password, unusable).
async function seedDemoAdmin(): Promise<boolean> {
  const usable =
    DEMO_ADMIN_PASSWORD !== "" &&
    (!IS_PRODUCTION || (DEMO_ADMIN_PASSWORD.length >= 12 && isPasswordStrongEnough(DEMO_ADMIN_PASSWORD)));

  if (!usable) {
    if (IS_PRODUCTION) {
      console.warn(
        "Demo admin is disabled in production. To enable it set DEMO_ADMIN_PASSWORD (12+ characters, letters and numbers) " +
          "and ADMIN_JWT_SECRET (openssl rand -hex 32)."
      );
    }
    // An earlier deploy may have created this account with the old public password: make it
    // unusable (random password, locked, sessions revoked) rather than leave it open.
    const existing = await prisma.adminUser.findUnique({ where: { email: DEMO_ADMIN_EMAIL } });
    if (existing) {
      await prisma.adminUser.update({
        where: { id: existing.id },
        data: {
          passwordHash: await hashPassword(randomBytes(32).toString("hex")),
          role: "MODERATOR",
          lockedUntil: new Date("2999-01-01T00:00:00Z"),
        },
      });
      await prisma.adminSession.updateMany({ where: { adminUserId: existing.id }, data: { revoked: true } });
    }
    return false;
  }

  const adminHash = await hashPassword(DEMO_ADMIN_PASSWORD);
  await prisma.adminUser.upsert({
    where: { email: DEMO_ADMIN_EMAIL },
    // Also clears any lockout, so re-running the seed (every deploy) always gives you a working login.
    update: { passwordHash: adminHash, role: DEMO_ADMIN_ROLE, failedLoginAttempts: 0, lockedUntil: null },
    create: { email: DEMO_ADMIN_EMAIL, passwordHash: adminHash, role: DEMO_ADMIN_ROLE },
  });

  if (!process.env.ADMIN_JWT_SECRET) {
    console.warn(
      "Demo admin exists but ADMIN_JWT_SECRET is not set, so admin login will fail with 503. " +
        "Set ADMIN_JWT_SECRET (e.g. `openssl rand -hex 32`) in your environment."
    );
  }
  return true;
}

// Only auto-run when executed directly (npm run demo:seed). When imported by
// server.ts, the server calls seedDemo() itself and keeps the DB connection.
if (require.main === module) {
  seedDemo()
    .catch((err) => {
      console.error("Demo seed failed:", err);
    })
    .finally(() => prisma.$disconnect());
}
