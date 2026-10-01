import { Router } from "express";
import rateLimit from "express-rate-limit";
import * as c from "../controllers/randomChat.controller";
import { requireAuth } from "../middleware/auth.middleware";
import { asyncHandler } from "../utils/asyncHandler";

export const randomChatRouter = Router();
randomChatRouter.use(requireAuth);

// Coarse per-IP+user ceiling on top of the finer per-user limiters inside the
// services (join/next, messages, skips).
randomChatRouter.use(
  rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `${req.userId ?? ""}:${req.ip}`,
    message: { success: false, error: { code: "RATE_LIMITED", message: "Too many requests. Slow down." } },
  })
);

randomChatRouter.get("/config", asyncHandler(c.config));
randomChatRouter.get("/settings", asyncHandler(c.getSettings));
randomChatRouter.patch("/settings", asyncHandler(c.updateSettings));

randomChatRouter.get("/status", asyncHandler(c.status));
randomChatRouter.post("/heartbeat", asyncHandler(c.heartbeat)); // REST fallback when the socket is down
randomChatRouter.post("/join", asyncHandler(c.join));
randomChatRouter.post("/leave", asyncHandler(c.leave));
randomChatRouter.post("/next", asyncHandler(c.next));

randomChatRouter.get("/session/:id", asyncHandler(c.getSession));
randomChatRouter.post("/session/:id/end", asyncHandler(c.endSession));
randomChatRouter.get("/session/:id/messages", asyncHandler(c.messages));
randomChatRouter.post("/session/:id/messages", asyncHandler(c.sendMessage)); // REST fallback used for retries when the socket is down
randomChatRouter.get("/session/:id/profile", asyncHandler(c.profile));
randomChatRouter.post("/session/:id/like", asyncHandler(c.like));
randomChatRouter.post("/session/:id/block", asyncHandler(c.block));
randomChatRouter.post("/session/:id/report", asyncHandler(c.report));
