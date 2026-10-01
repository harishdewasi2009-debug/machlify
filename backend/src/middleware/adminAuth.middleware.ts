import { NextFunction, Request, Response } from "express";
import { prisma } from "../config/prisma";
import { Errors } from "../utils/apiError";
import { verifyAdminAccessToken } from "../utils/adminTokens";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      adminUserId?: string;
      adminSessionId?: string;
      adminRole?: string;
    }
  }
}

// Deliberately does not reuse requireAuth. A cookie named the same as the
// end-user one, or a token that happened to verify under the wrong secret,
// must never grant admin access — this checks a distinct cookie
// (adminAccessToken), a distinct JWT secret, and a distinct session table
// (AdminSession, not Session).
export async function requireAdminAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = req.cookies?.adminAccessToken as string | undefined;
    if (!token) throw Errors.adminUnauthorized();

    const payload = verifyAdminAccessToken(token);

    const session = await prisma.adminSession.findUnique({ where: { id: payload.adminSessionId } });
    if (!session || session.revoked || session.expiresAt < new Date()) {
      throw Errors.adminUnauthorized();
    }

    const admin = await prisma.adminUser.findUnique({ where: { id: payload.sub } });
    if (!admin) throw Errors.adminUnauthorized();

    req.adminUserId = admin.id;
    req.adminSessionId = session.id;
    req.adminRole = admin.role;
    next();
  } catch {
    next(Errors.adminUnauthorized());
  }
}

// Gate the most sensitive actions (suspending/restoring a real user's
// account, forcing a report resolution) behind ADMIN specifically —
// MODERATOR can review/approve content (photos, verification, report
// triage) but can't take account-level action on a real user.
export function requireAdminRole(...roles: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.adminRole || !roles.includes(req.adminRole)) {
      return next(Errors.adminForbidden());
    }
    next();
  };
}
