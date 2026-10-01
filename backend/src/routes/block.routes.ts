import { Router } from "express";
import * as blockController from "../controllers/block.controller";
import { requireAuth } from "../middleware/auth.middleware";
import { asyncHandler } from "../utils/asyncHandler";

export const blockRouter = Router();

blockRouter.use(requireAuth);

blockRouter.get("/", asyncHandler(blockController.list));
blockRouter.post("/", asyncHandler(blockController.create));
blockRouter.delete("/:userId", asyncHandler(blockController.remove));
