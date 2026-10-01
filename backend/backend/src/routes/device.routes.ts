import { Router } from "express";
import * as deviceController from "../controllers/device.controller";
import { requireAuth } from "../middleware/auth.middleware";
import { asyncHandler } from "../utils/asyncHandler";

export const deviceRouter = Router();

deviceRouter.use(requireAuth);

deviceRouter.get("/vapid-public-key", asyncHandler(deviceController.vapidPublicKey));
deviceRouter.post("/push-subscription", asyncHandler(deviceController.registerSubscription));
deviceRouter.delete("/push-subscription", asyncHandler(deviceController.unregisterSubscription));
