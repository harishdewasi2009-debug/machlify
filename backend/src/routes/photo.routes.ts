import { Router } from "express";
import multer from "multer";
import * as photoController from "../controllers/photo.controller";
import { requireAuth } from "../middleware/auth.middleware";
import { uploadSinglePhoto } from "../middleware/upload.middleware";
import { uploadRateLimiter } from "../middleware/rateLimit.middleware";
import { ApiError } from "../utils/apiError";
import { asyncHandler } from "../utils/asyncHandler";

export const photoRouter = Router();

photoRouter.use(requireAuth);

// multer is callback-based, so its errors (oversized file, wrong field name,
// too many files) need converting into our standard error shape here rather
// than being left to Express's default HTML error page.
function handleUpload(req: Parameters<typeof uploadSinglePhoto>[0], res: Parameters<typeof uploadSinglePhoto>[1], next: (err?: unknown) => void) {
  uploadSinglePhoto(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) {
      return next(new ApiError(400, "UPLOAD_ERROR", err.message));
    }
    if (err) return next(err);
    next();
  });
}

photoRouter.post("/", uploadRateLimiter, handleUpload, asyncHandler(photoController.upload));
photoRouter.get("/", asyncHandler(photoController.list));
photoRouter.patch("/reorder", asyncHandler(photoController.reorder));
photoRouter.patch("/:id/primary", asyncHandler(photoController.setPrimary));
photoRouter.delete("/:id", asyncHandler(photoController.remove));
