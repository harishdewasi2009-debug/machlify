import { NextFunction, Request, Response } from "express";
import { prisma } from "../config/prisma";
import { Errors } from "../utils/apiError";
import { verifyAccessToken } from "../utils/tokens";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
      sessionId?: string;
    }
  }
}

// Authorization always comes from the verified session on the backend —
// never from a userId the frontend might include in a request body.
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = req.cookies?.accessToken as string | undefined;
    if (!token) throw Errors.unauthorized();

    const payload = verifyAccessToken(token);

    const session = await prisma.session.findUnique({ where: { id: payload.sessionId } });
    if (!session || session.revoked || session.expiresAt < new Date()) {
      throw Errors.unauthorized();
    }

    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || user.status !== "ACTIVE") {
      throw Errors.unauthorized();
    }

    req.userId = user.id;
    req.sessionId = session.id;
    next();
  } catch {
    next(Errors.unauthorized());
  }
}
