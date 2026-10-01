import { PrismaClient } from "@prisma/client";
import { isProduction } from "./env";

// Reuse a single client across hot reloads in dev so repeated `tsx watch`
// restarts don't exhaust the Postgres connection pool.
const globalForPrisma = global as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: isProduction ? ["error", "warn"] : ["error", "warn", "query"],
  });

if (!isProduction) {
  globalForPrisma.prisma = prisma;
}
