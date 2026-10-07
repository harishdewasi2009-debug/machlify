import { env } from "../config/env";
import { cleanupUser as cleanupRandomChatUser } from "../services/randomChat/matchmaking.service";
import { Request, Response } from "express";
import { Errors } from "../utils/apiError";
import { clearAuthCookies, setAuthCookies } from "../utils/cookies";
import {
  changePasswordSchema,
  deleteAccountSchema,
  googleLoginSchema,
  googleRegisterSchema,
  appleLoginSchema,
  appleRegisterSchema,
  loginSchema,
  registerSchema,
  requestPasswordResetSchema,
  resetPasswordSchema,
  restoreAccountSchema,
  verifyEmailSchema,
} from "../validators/auth.validator";
import * as authService from "../services/auth.service";

function deviceContext(req: Request) {
  return { userAgent: req.get("user-agent") ?? undefined, ipAddress: req.ip };
}

// Only ever return safe, public fields — never passwordHash, googleId, etc.
function toPublicUser(user: { id: string; email: string; emailVerified: boolean }) {
  return { id: user.id, email: user.email, emailVerified: user.emailVerified };
}

export async function register(req: Request, res: Response) {
  const input = registerSchema.parse(req.body);
  const user = await authService.registerUser(input);
  res.status(201).json({ success: true, data: { user, message: "Account created. You can sign in now." } });
}

export async function verifyEmail(req: Request, res: Response) {
  const { token } = verifyEmailSchema.parse(req.body);
  await authService.verifyEmailToken(token);
  res.json({ success: true, data: { verified: true } });
}

export async function login(req: Request, res: Response) {
  const { email, password } = loginSchema.parse(req.body);
  const { user, accessToken, refreshTokenRaw } = await authService.loginWithPassword(
    email,
    password,
    deviceContext(req)
  );
  setAuthCookies(res, accessToken, refreshTokenRaw);
  res.json({ success: true, data: { user: toPublicUser(user) } });
}

export async function googleLogin(req: Request, res: Response) {
  const { idToken } = googleLoginSchema.parse(req.body);
  const { user, accessToken, refreshTokenRaw } = await authService.loginWithGoogle(idToken, deviceContext(req));
  setAuthCookies(res, accessToken, refreshTokenRaw);
  res.json({ success: true, data: { user: toPublicUser(user) } });
}

export async function googleRegister(req: Request, res: Response) {
  const input = googleRegisterSchema.parse(req.body);
  const { user, accessToken, refreshTokenRaw } = await authService.registerWithGoogle(input, deviceContext(req));
  setAuthCookies(res, accessToken, refreshTokenRaw);
  res.status(201).json({ success: true, data: { user: toPublicUser(user) } });
}

export async function appleLogin(req: Request, res: Response) {
  const { idToken } = appleLoginSchema.parse(req.body);
  const { user, accessToken, refreshTokenRaw } = await authService.loginWithApple(idToken, deviceContext(req));
  setAuthCookies(res, accessToken, refreshTokenRaw);
  res.json({ success: true, data: { user: toPublicUser(user) } });
}

export async function appleRegister(req: Request, res: Response) {
  const input = appleRegisterSchema.parse(req.body);
  const { user, accessToken, refreshTokenRaw } = await authService.registerWithApple(input, deviceContext(req));
  setAuthCookies(res, accessToken, refreshTokenRaw);
  res.status(201).json({ success: true, data: { user: toPublicUser(user) } });
}

// Public (non-secret) client IDs so the frontend never has to hardcode them.
export async function publicConfig(_req: Request, res: Response) {
  res.json({
    success: true,
    data: { googleClientId: env.GOOGLE_CLIENT_ID || null, appleClientId: env.APPLE_CLIENT_ID || null },
  });
}

export async function refresh(req: Request, res: Response) {
  const rawRefreshToken = req.cookies?.refreshToken as string | undefined;
  if (!rawRefreshToken) throw Errors.unauthorized();

  const { accessToken, refreshTokenRaw } = await authService.refreshSession(rawRefreshToken, deviceContext(req));
  setAuthCookies(res, accessToken, refreshTokenRaw);
  res.json({ success: true, data: { refreshed: true } });
}

export async function logout(req: Request, res: Response) {
  if (req.userId) {
    // Leave the Random Chat queue / end any live chat so a logged-out user is never matched.
    await cleanupRandomChatUser(req.userId).catch(() => undefined);
  }
  if (req.sessionId) {
    await authService.logout(req.sessionId);
  }
  clearAuthCookies(res);
  res.json({ success: true, data: { loggedOut: true } });
}

export async function logoutAllDevices(req: Request, res: Response) {
  if (!req.userId) throw Errors.unauthorized();
  await authService.logoutAllDevices(req.userId);
  clearAuthCookies(res);
  res.json({ success: true, data: { loggedOut: true } });
}

export async function requestPasswordReset(req: Request, res: Response) {
  const { email } = requestPasswordResetSchema.parse(req.body);
  await authService.requestPasswordReset(email);
  // Always the same response, whether or not the account exists.
  res.json({ success: true, data: { message: "If an account exists for this email, a reset link has been sent." } });
}

export async function resetPassword(req: Request, res: Response) {
  const { token, newPassword } = resetPasswordSchema.parse(req.body);
  await authService.resetPassword(token, newPassword);
  res.json({ success: true, data: { reset: true } });
}

export async function changePassword(req: Request, res: Response) {
  if (!req.userId) throw Errors.unauthorized();
  const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);
  await authService.changePassword(req.userId, currentPassword, newPassword, req.sessionId);
  res.json({ success: true, data: { changed: true } });
}

export async function deleteAccount(req: Request, res: Response) {
  if (!req.userId) throw Errors.unauthorized();
  const { password } = deleteAccountSchema.parse(req.body);
  const { scheduledDeletionAt, emailSent } = await authService.requestAccountDeletion(req.userId, password);
  clearAuthCookies(res);
  res.json({
    success: true,
    data: {
      status: "PENDING_DELETION",
      scheduledDeletionAt,
      restoreEmailSent: emailSent,
      message: emailSent
        ? "You've been logged out everywhere. Your account will be permanently deleted on the scheduled date unless you cancel from the link we emailed you."
        : "You've been logged out everywhere. Your account will be permanently deleted on the scheduled date. We couldn't send a restore email — contact support before then if you change your mind.",
    },
  });
}

export async function restoreAccount(req: Request, res: Response) {
  const { token } = restoreAccountSchema.parse(req.body);
  await authService.restoreAccount(token);
  res.json({ success: true, data: { restored: true } });
}

export async function me(req: Request, res: Response) {
  if (!req.userId) throw Errors.unauthorized();
  res.json({ success: true, data: { userId: req.userId } });
}
