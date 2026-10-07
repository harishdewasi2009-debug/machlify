import { Router } from "express";
import * as reportController from "../controllers/report.controller";
import { requireAuth } from "../middleware/auth.middleware";
import { reportRateLimiter } from "../middleware/rateLimit.middleware";
import { asyncHandler } from "../utils/asyncHandler";

export const reportRouter = Router();

reportRouter.use(requireAuth);

reportRouter.post("/", reportRateLimiter, asyncHandler(reportController.create));
