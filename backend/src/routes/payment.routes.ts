import { Router } from "express";
import * as paymentController from "../controllers/payment.controller";
import { checkoutRateLimiter } from "../middleware/rateLimit.middleware";
import { requireAuth } from "../middleware/auth.middleware";
import { asyncHandler } from "../utils/asyncHandler";

export const paymentRouter = Router();

paymentRouter.use(requireAuth);

paymentRouter.post("/checkout", checkoutRateLimiter, asyncHandler(paymentController.checkout));
paymentRouter.post("/verify", asyncHandler(paymentController.verify));
paymentRouter.get("/history", asyncHandler(paymentController.history));
