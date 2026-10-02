import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import fs from "fs";
import path from "path";
import helmet from "helmet";
import { env } from "./config/env";
import { errorHandler } from "./middleware/errorHandler.middleware";
import { authRouter } from "./routes/auth.routes";
import { photoRouter } from "./routes/photo.routes";
import { profileRouter } from "./routes/profile.routes";
import { discoveryRouter } from "./routes/discovery.routes";
import { swipeRouter } from "./routes/swipe.routes";
import { matchRouter } from "./routes/match.routes";
import { blockRouter } from "./routes/block.routes";
import { reportRouter } from "./routes/report.routes";
import { notificationRouter } from "./routes/notification.routes";
import { conversationRouter } from "./routes/conversation.routes";
import { verificationRouter } from "./routes/verification.routes";
import { callRouter } from "./routes/call.routes";
import { deviceRouter } from "./routes/device.routes";
import { paymentRouter } from "./routes/payment.routes";
import { subscriptionRouter } from "./routes/subscription.routes";
import { adminRouter } from "./routes/admin.routes";
import { randomChatRouter } from "./routes/randomChat.routes";
import * as verificationController from "./controllers/verification.controller";
import * as paymentController from "./controllers/payment.controller";
import { asyncHandler } from "./utils/asyncHandler";

export const app = express();

// Serve the frontend (index.html, admin.html, sw.js) from the same server, so
// the website and the API share one address (no CORS/cookie problems).
// Registered BEFORE helmet() so helmet's strict Content-Security-Policy
// (which blocks inline <script>) is not applied to these static pages.
const frontendDir = [path.resolve(__dirname, "../../frontend"), path.resolve(__dirname, "../frontend")].find((dir) =>
  fs.existsSync(path.join(dir, "index.html"))
);
if (frontendDir) {
  app.use(express.static(frontendDir));
}

app.use(helmet());
app.use(
  cors({
    origin: env.APP_ORIGIN,
    credentials: true, // required so the frontend's cookies (accessToken/refreshToken) are sent
  })
);

// Stripe's webhook signature is computed over the exact raw request bytes,
// so this route needs express.raw() instead of the global JSON parser below
// — and it must be registered first, since it's a terminal route handler
// that responds before the request ever reaches express.json().
app.post(
  "/api/verification/webhook",
  express.raw({ type: "application/json" }),
  asyncHandler(verificationController.webhook)
);

// Same reasoning as above: Razorpay's webhook signature is computed over
// the exact raw request bytes, so this route also needs express.raw() and
// must be registered ahead of the global JSON parser.
app.post(
  "/api/payments/webhook",
  express.raw({ type: "application/json" }),
  asyncHandler(paymentController.webhook)
);

app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

app.get("/health", (_req, res) => res.json({ success: true, data: { status: "ok" } }));

app.use("/api/auth", authRouter);
app.use("/api/photos", photoRouter);
app.use("/api/profile", profileRouter);
app.use("/api/discovery", discoveryRouter);
app.use("/api/swipes", swipeRouter);
app.use("/api/matches", matchRouter);
app.use("/api/blocks", blockRouter);
app.use("/api/reports", reportRouter);
app.use("/api/notifications", notificationRouter);
app.use("/api/conversations", conversationRouter);
app.use("/api/verification", verificationRouter);
app.use("/api/calls", callRouter);
app.use("/api/devices", deviceRouter);
app.use("/api/payments", paymentRouter);
app.use("/api/subscription", subscriptionRouter);
app.use("/api/random-chat", randomChatRouter);
app.use("/api/admin", adminRouter);

// 404 for anything else under /api
app.use("/api", (_req, res) => {
  res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Route not found." } });
});

app.use(errorHandler);
