import { Router } from "express";
import * as subscriptionController from "../controllers/subscription.controller";
import { requireAuth } from "../middleware/auth.middleware";
import { asyncHandler } from "../utils/asyncHandler";

export const subscriptionRouter = Router();

subscriptionRouter.get("/plans", asyncHandler(subscriptionController.plans));

subscriptionRouter.use(requireAuth);

subscriptionRouter.get("/", asyncHandler(subscriptionController.getSubscription));
subscriptionRouter.post("/cancel", asyncHandler(subscriptionController.cancel));
