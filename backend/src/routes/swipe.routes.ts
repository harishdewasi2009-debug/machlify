import { Router } from "express";
import * as swipeController from "../controllers/swipe.controller";
import { requireAuth } from "../middleware/auth.middleware";
import { asyncHandler } from "../utils/asyncHandler";

export const swipeRouter = Router();

swipeRouter.use(requireAuth);

swipeRouter.post("/", asyncHandler(swipeController.create));
