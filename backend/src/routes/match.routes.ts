import { Router } from "express";
import * as matchController from "../controllers/match.controller";
import { requireAuth } from "../middleware/auth.middleware";
import { asyncHandler } from "../utils/asyncHandler";

export const matchRouter = Router();

matchRouter.use(requireAuth);

matchRouter.get("/", asyncHandler(matchController.list));
matchRouter.delete("/:id", asyncHandler(matchController.remove));
