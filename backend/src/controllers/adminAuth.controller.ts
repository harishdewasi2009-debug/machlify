import { Request, Response } from "express";
import { Errors } from "../utils/apiError";
import { setAdminAuthCookie, clearAdminAuthCookie } from "../utils/cookies";
import { adminLoginSchema } from "../validators/admin.validator";
import * as adminAuthService from "../services/adminAuth.service";

export async function login(req: Request, res: Response) {
  const { email, password } = adminLoginSchema.parse(req.body);
  const { accessToken, admin } = await adminAuthService.loginAdmin(email, password, req);
  setAdminAuthCookie(res, accessToken);
  res.json({ success: true, data: { admin } });
}

export async function logout(req: Request, res: Response) {
  if (!req.adminUserId || !req.adminSessionId) throw Errors.adminUnauthorized();
  await adminAuthService.logoutAdmin(req.adminUserId, req.adminSessionId);
  clearAdminAuthCookie(res);
  res.json({ success: true, data: null });
}

export async function me(req: Request, res: Response) {
  if (!req.adminUserId) throw Errors.adminUnauthorized();
  const admin = await adminAuthService.getMe(req.adminUserId);
  res.json({ success: true, data: admin });
}
