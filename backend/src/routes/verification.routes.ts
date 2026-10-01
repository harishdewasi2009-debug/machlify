import { Router } from "express";
import multer from "multer";
import { uploadSinglePhoto } from "../middleware/upload.middleware";
import { ApiError } from "../utils/apiError";
import * as verificationController from "../controllers/verification.controller";
import { requireAuth } from "../middleware/auth.middleware";
import { asyncHandler } from "../utils/asyncHandler";

export const verificationRouter = Router();

verificationRouter.use(requireAuth);

verificationRouter.post("/start", asyncHandler(verificationController.start));
verificationRouter.get("/status", asyncHandler(verificationController.status));

function handleUpload(req: Parameters<typeof uploadSinglePhoto>[0], res: Parameters<typeof uploadSinglePhoto>[1], next: (err?: unknown) => void) {
  uploadSinglePhoto(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) return next(new ApiError(400, "UPLOAD_ERROR", err.message));
    if (err) return next(err);
    next();
  });
}

// Selfie-based verification, reviewed by a human moderator (no third-party
// provider needed). Stripe Identity via /start remains available too.
verificationRouter.post("/photo", handleUpload, asyncHandler(verificationController.submitSelfie));
