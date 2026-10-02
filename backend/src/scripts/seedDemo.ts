// Creates (or refreshes) a ready-to-use DEMO user, a demo admin, and a few
// demo profiles to swipe on. Safe to run on every deploy: everything is an
// upsert keyed by email, so nothing is duplicated.
//
// Demo user:  demo@matchify.app  /  Demo@12345
// Demo admin: demoadmin@matchify.app  /  DemoAdmin@12345
//
// Override with DEMO_EMAIL / DEMO_PASSWORD / DEMO_ADMIN_EMAIL /
// DEMO_ADMIN_PASSWORD. Disable entirely with SEED_DEMO=false.
//
// Run manually: npm run demo:seed   (after `npm run build`: npm run demo:seed:prod)
import { prisma } from "../config/prisma";
import { hashPassword } from "../utils/password";

const DEMO_EMAIL = process.env.DEMO_EMAIL ?? "demo@matchify.app";
const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "Demo@12345";
const DEMO_ADMIN_EMAIL = process.env.DEMO_ADMIN_EMAIL ?? "demoadmin@matchify.app";
const DEMO_ADMIN_PASSWORD = process.env.DEMO_ADMIN_PASSWORD ?? "DemoAdmin@12345";

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

async function main() {
  if (process.env.SEED_DEMO === "false") {
    console.log("SEED_DEMO=false — skipping demo seed.");
    return;
  }

  const userHash = await hashPassword(DEMO_PASSWORD);

  // The demo user is a man looking for women; the demo profiles are women
  // looking for men, so they appear in each other's discovery deck.
  await upsertPerson(DEMO_USER, userHash, 0, ["WOMAN"]);
  for (let i = 0; i < DEMO_CANDIDATES.length; i++) {
    await upsertPerson(DEMO_CANDIDATES[i], userHash, i + 1, ["MAN"]);
  }

  const adminHash = await hashPassword(DEMO_ADMIN_PASSWORD);
  await prisma.adminUser.upsert({
    where: { email: DEMO_ADMIN_EMAIL },
    update: { passwordHash: adminHash, role: "ADMIN" },
    create: { email: DEMO_ADMIN_EMAIL, passwordHash: adminHash, role: "ADMIN" },
  });

  console.log(`Demo ready -> user: ${DEMO_EMAIL} / ${DEMO_PASSWORD} | admin: ${DEMO_ADMIN_EMAIL} / ${DEMO_ADMIN_PASSWORD}`);
}

main()
  .catch((err) => {
    // Never block the server from starting just because the demo seed failed.
    console.error("Demo seed failed:", err);
    process.exitCode = 0;
  })
  .finally(() => prisma.$disconnect());
