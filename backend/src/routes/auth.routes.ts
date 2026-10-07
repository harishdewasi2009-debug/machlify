import { Router } from "express";
import * as authController from "../controllers/auth.controller";
import { requireAuth } from "../middleware/auth.middleware";
import {
  loginRateLimiter,
  passwordResetRateLimiter,
  registerRateLimiter,
  tokenEndpointRateLimiter,
} from "../middleware/rateLimit.middleware";
import { asyncHandler } from "../utils/asyncHandler";

export const authRouter = Router();

authRouter.post("/register", registerRateLimiter, asyncHandler(authController.register));
authRouter.post("/verify-email", tokenEndpointRateLimiter, asyncHandler(authController.verifyEmail));

authRouter.post("/login", loginRateLimiter, asyncHandler(authController.login));
authRouter.post("/google", loginRateLimiter, asyncHandler(authController.googleLogin));

authRouter.post("/google/register", registerRateLimiter, asyncHandler(authController.googleRegister));
authRouter.post("/apple", loginRateLimiter, asyncHandler(authController.appleLogin));
authRouter.post("/apple/register", registerRateLimiter, asyncHandler(authController.appleRegister));
authRouter.get("/config", asyncHandler(authController.publicConfig));
authRouter.post("/refresh", tokenEndpointRateLimiter, asyncHandler(authController.refresh));
authRouter.post("/logout", requireAuth, asyncHandler(authController.logout));
authRouter.post("/logout-all", requireAuth, asyncHandler(authController.logoutAllDevices));

authRouter.post("/password/forgot", passwordResetRateLimiter, asyncHandler(authController.requestPasswordReset));
authRouter.post("/password/reset", passwordResetRateLimiter, asyncHandler(authController.resetPassword));
authRouter.post("/password/change", requireAuth, asyncHandler(authController.changePassword));

authRouter.get("/me", requireAuth, asyncHandler(authController.me));

authRouter.delete("/account", requireAuth, asyncHandler(authController.deleteAccount));
// Not requireAuth: login is disabled for a PENDING_DELETION account, so
// restoring has to work from the emailed token alone. Rate-limited like the
// other unauthenticated token-consuming endpoints (password reset).
authRouter.post("/account/restore", passwordResetRateLimiter, asyncHandler(authController.restoreAccount));
