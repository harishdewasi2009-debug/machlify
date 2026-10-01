import { Router } from "express";
import * as profileController from "../controllers/profile.controller";
import { requireAuth } from "../middleware/auth.middleware";
import { asyncHandler } from "../utils/asyncHandler";

export const profileRouter = Router();

profileRouter.use(requireAuth);

profileRouter.get("/", asyncHandler(profileController.getMe));
profileRouter.patch("/", asyncHandler(profileController.updateMe));
profileRouter.patch("/location", asyncHandler(profileController.updateLocation));
profileRouter.patch("/preferences", asyncHandler(profileController.updatePreferences));
profileRouter.patch("/interests", asyncHandler(profileController.updateInterests));
