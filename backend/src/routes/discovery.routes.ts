import { Router } from "express";
import * as discoveryController from "../controllers/discovery.controller";
import { requireAuth } from "../middleware/auth.middleware";
import { asyncHandler } from "../utils/asyncHandler";

export const discoveryRouter = Router();

discoveryRouter.get("/", requireAuth, asyncHandler(discoveryController.feed));
