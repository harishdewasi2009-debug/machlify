import { Request } from "express";
import { prisma } from "../config/prisma";
import { env } from "../config/env";
import { Errors } from "../utils/apiError";
import { verifyPassword } from "../utils/password";
import { signAdminAccessToken } from "../utils/adminTokens";
import { addMinutes } from "../utils/tokens";
import { logAdminAction } from "./adminAudit.service";

export async function loginAdmin(email: string, password: string, req: Request) {
  const admin = await prisma.adminUser.findUnique({ where: { email } });
  // Same generic error whether the email doesn't exist or the password is
  // wrong — an admin login endpoint is a high-value target for account
  // enumeration.
  if (!admin) throw Errors.invalidCredentials();

  if (admin.lockedUntil && admin.lockedUntil > new Date()) {
    throw Errors.accountLocked();
  }

  const valid = await verifyPassword(password, admin.passwordHash);
  if (!valid) {
    const attempts = admin.failedLoginAttempts + 1;
    const shouldLock = attempts >= env.ADMIN_LOGIN_LOCK_THRESHOLD;
    await prisma.adminUser.update({
      where: { id: admin.id },
      data: {
        failedLoginAttempts: shouldLock ? 0 : attempts,
        lockedUntil: shouldLock ? addMinutes(new Date(), env.ACCOUNT_LOCK_MINUTES) : null,
      },
    });
    throw Errors.invalidCredentials();
  }

  await prisma.adminUser.update({ where: { id: admin.id }, data: { failedLoginAttempts: 0, lockedUntil: null } });

  const session = await prisma.adminSession.create({
    data: {
      adminUserId: admin.id,
      userAgent: req.headers["user-agent"] ?? null,
      ipAddress: req.ip ?? null,
      expiresAt: new Date(Date.now() + env.ADMIN_SESSION_TTL_HOURS * 60 * 60 * 1000),
    },
  });

  const accessToken = signAdminAccessToken({ sub: admin.id, adminSessionId: session.id, role: admin.role });

  await logAdminAction(admin.id, "ADMIN_LOGIN", "AdminSession", session.id);

  return { accessToken, admin: { id: admin.id, email: admin.email, role: admin.role } };
}

export async function logoutAdmin(adminUserId: string, adminSessionId: string) {
  await prisma.adminSession.update({ where: { id: adminSessionId }, data: { revoked: true } });
  await logAdminAction(adminUserId, "ADMIN_LOGOUT", "AdminSession", adminSessionId);
}

export async function getMe(adminUserId: string) {
  const admin = await prisma.adminUser.findUnique({
    where: { id: adminUserId },
    select: { id: true, email: true, role: true, createdAt: true },
  });
  if (!admin) throw Errors.adminUnauthorized();
  return admin;
}
