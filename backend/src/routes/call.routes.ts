import { Router } from "express";
import * as callController from "../controllers/call.controller";
import { requireAuth } from "../middleware/auth.middleware";
import { asyncHandler } from "../utils/asyncHandler";

export const callRouter = Router();

callRouter.use(requireAuth);

// Call invite/accept/reject/end all happen over the socket (see
// websocket/socket.ts) so both parties get the same event ordering guarantee
// message:send has. These two REST endpoints exist for things a socket
// event doesn't fit well: fetching short-lived TURN credentials before
// opening the RTCPeerConnection, and reading past call history.
callRouter.get("/turn-credentials", asyncHandler(callController.turnCredentials));
callRouter.get("/history", asyncHandler(callController.history));
callRouter.get("/:id", asyncHandler(callController.getOne));
