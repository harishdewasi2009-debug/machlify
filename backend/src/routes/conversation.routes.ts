import { Router } from "express";
import * as conversationController from "../controllers/conversation.controller";
import { requireAuth } from "../middleware/auth.middleware";
import { asyncHandler } from "../utils/asyncHandler";

export const conversationRouter = Router();

conversationRouter.use(requireAuth);

conversationRouter.get("/", asyncHandler(conversationController.list));
conversationRouter.get("/:id/messages", asyncHandler(conversationController.getMessages));
conversationRouter.post("/:id/messages", asyncHandler(conversationController.sendMessage));
conversationRouter.patch("/:id/read", asyncHandler(conversationController.markRead));
