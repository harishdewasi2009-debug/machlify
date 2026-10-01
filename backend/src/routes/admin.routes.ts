import { Router } from "express";
import { requireAdminAuth, requireAdminRole } from "../middleware/adminAuth.middleware";
import { adminLoginRateLimiter } from "../middleware/rateLimit.middleware";
import { asyncHandler } from "../utils/asyncHandler";
import * as adminAuthController from "../controllers/adminAuth.controller";
import * as adminUsersController from "../controllers/adminUsers.controller";
import * as adminModerationController from "../controllers/adminModeration.controller";
import * as adminReportsController from "../controllers/adminReports.controller";
import * as adminPaymentsController from "../controllers/adminPayments.controller";
import * as adminSafetyController from "../controllers/adminSafety.controller";
import * as adminAuditController from "../controllers/adminAudit.controller";
import * as adminRc from "../controllers/adminRandomChat.controller";

export const adminRouter = Router();

// --- Auth (not behind requireAdminAuth) ---
adminRouter.post("/auth/login", adminLoginRateLimiter, asyncHandler(adminAuthController.login));

// Everything below requires a valid admin session.
adminRouter.use(requireAdminAuth);

adminRouter.post("/auth/logout", asyncHandler(adminAuthController.logout));
adminRouter.get("/auth/me", asyncHandler(adminAuthController.me));

// --- Users --- (MODERATOR can view; only ADMIN can suspend/restore)
adminRouter.get("/users", asyncHandler(adminUsersController.list));
adminRouter.get("/users/:id", asyncHandler(adminUsersController.detail));
adminRouter.post("/users/:id/suspend", requireAdminRole("ADMIN"), asyncHandler(adminUsersController.suspend));
adminRouter.post("/users/:id/restore", requireAdminRole("ADMIN"), asyncHandler(adminUsersController.restore));

// --- Photo moderation --- (review is a MODERATOR-level action)
adminRouter.get("/photos", asyncHandler(adminModerationController.listPhotos));
adminRouter.post("/photos/:id/approve", asyncHandler(adminModerationController.approvePhoto));
adminRouter.post("/photos/:id/reject", asyncHandler(adminModerationController.rejectPhoto));

// --- Identity verification review --- (MODERATOR-level)
adminRouter.get("/verifications", asyncHandler(adminModerationController.listVerifications));
adminRouter.post("/verifications/:id/approve", asyncHandler(adminModerationController.approveVerification));
adminRouter.post("/verifications/:id/reject", asyncHandler(adminModerationController.rejectVerification));

// --- Reports --- (triage is MODERATOR-level; suspending the reported user is ADMIN-level)
adminRouter.get("/reports", asyncHandler(adminReportsController.list));
adminRouter.patch("/reports/:id", asyncHandler(adminReportsController.updateStatus));
adminRouter.post(
  "/reports/:id/suspend-reported",
  requireAdminRole("ADMIN"),
  asyncHandler(adminReportsController.suspendReported)
);

// --- Payments / subscriptions --- (read-only for both roles)
adminRouter.get("/payments", asyncHandler(adminPaymentsController.listPayments));
adminRouter.get("/subscriptions", asyncHandler(adminPaymentsController.listSubscriptions));

// --- Safety --- (read-only for both roles)
adminRouter.get("/safety/blocks", asyncHandler(adminSafetyController.listBlocks));
adminRouter.get("/safety/flagged-users", asyncHandler(adminSafetyController.listFlaggedUsers));

// --- Audit log --- (read-only for both roles — visibility into all admin action, including MODERATOR's own)
adminRouter.get("/audit-logs", asyncHandler(adminAuditController.list));

// --- Random Chat --- (read + end-session + resolve are MODERATOR-level; bans are ADMIN-level)
adminRouter.get("/random-chat/stats", asyncHandler(adminRc.stats));
adminRouter.get("/random-chat/sessions", asyncHandler(adminRc.sessions));
adminRouter.post("/random-chat/sessions/:id/end", asyncHandler(adminRc.endSession));
adminRouter.get("/random-chat/alerts", asyncHandler(adminRc.alerts));
adminRouter.post("/random-chat/alerts/:id/resolve", asyncHandler(adminRc.resolveAlert));
adminRouter.get("/random-chat/reports", asyncHandler(adminRc.reports));
adminRouter.get("/random-chat/reports/:id/messages", requireAdminRole("ADMIN"), asyncHandler(adminRc.reportMessages));
adminRouter.get("/random-chat/bans", asyncHandler(adminRc.bans));
adminRouter.get("/random-chat/users/:userId/review", asyncHandler(adminRc.review));
adminRouter.post("/random-chat/users/:userId/ban", requireAdminRole("ADMIN"), asyncHandler(adminRc.ban));
adminRouter.post("/random-chat/users/:userId/unban", requireAdminRole("ADMIN"), asyncHandler(adminRc.unban));
