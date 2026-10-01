// Creates (or rotates the password/role of) an AdminUser. Deliberately a
// CLI script run with direct database/server access, not an HTTP endpoint —
// there must be no network-reachable way to self-register an admin account.
//
// Usage:
//   ADMIN_EMAIL=admin@matchify.example ADMIN_PASSWORD='...' npm run admin:create
//   ADMIN_EMAIL=... ADMIN_PASSWORD=... ADMIN_ROLE=MODERATOR npm run admin:create
//
// ADMIN_ROLE defaults to "ADMIN" (the highest privilege level in this app —
// see adminAuth.middleware.ts). Running this again for an existing email
// rotates that admin's password (and role, if given) rather than creating a
// duplicate.
import { prisma } from "../config/prisma";
import { hashPassword, isPasswordStrongEnough } from "../utils/password";

async function main() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  const role = process.env.ADMIN_ROLE ?? "ADMIN";

  if (!email || !password) {
    console.error("Usage: ADMIN_EMAIL=... ADMIN_PASSWORD=... [ADMIN_ROLE=ADMIN|MODERATOR] npm run admin:create");
    process.exit(1);
  }

  if (!["ADMIN", "MODERATOR"].includes(role)) {
    console.error('ADMIN_ROLE must be "ADMIN" or "MODERATOR".');
    process.exit(1);
  }

  if (!isPasswordStrongEnough(password)) {
    console.error("Password must be at least 10 characters and include a letter and a number.");
    process.exit(1);
  }

  const passwordHash = await hashPassword(password);

  const admin = await prisma.adminUser.upsert({
    where: { email },
    update: { passwordHash, role },
    create: { email, passwordHash, role },
  });

  console.log(`Admin account ready: ${admin.email} (role: ${admin.role}, id: ${admin.id})`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
