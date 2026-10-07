import { Router } from "express";
import * as conversationController from "../controllers/conversation.controller";
import { uploadChatMedia } from "../middleware/upload.middleware";
import { requireAuth } from "../middleware/auth.middleware";
import { messageRateLimiter, uploadRateLimiter } from "../middleware/rateLimit.middleware";
import { asyncHandler } from "../utils/asyncHandler";

export const conversationRouter = Router();

conversationRouter.use(requireAuth);

conversationRouter.get("/", asyncHandler(conversationController.list));
conversationRouter.get("/:id/messages", asyncHandler(conversationController.getMessages));
conversationRouter.post("/:id/messages", messageRateLimiter, asyncHandler(conversationController.sendMessage));
conversationRouter.post("/:id/media", messageRateLimiter, uploadRateLimiter, uploadChatMedia, asyncHandler(conversationController.sendMedia));
conversationRouter.patch("/:id/read", asyncHandler(conversationController.markRead));
