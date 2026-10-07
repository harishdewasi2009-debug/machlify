import multer from "multer";
import { env } from "../config/env";

// Memory storage: the file never touches disk, which matters because this
// process may run multiple instances behind a load balancer — nothing here
// should depend on local "/uploads".
export const uploadSinglePhoto = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.MAX_PHOTO_SIZE_MB * 1024 * 1024,
    files: 1,
  },
}).single("file");

// Face verification: two live frames (neutral + liveness step) in one request.
export const uploadFaceFrames = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_PHOTO_SIZE_MB * 1024 * 1024, files: 2 },
}).fields([
  { name: "neutral", maxCount: 1 },
  { name: "challenge", maxCount: 1 },
]);

export const CHAT_MEDIA_TYPES: Record<string, { ext: string; kind: "IMAGE" | "AUDIO" }> = {
  "image/jpeg": { ext: "jpg", kind: "IMAGE" },
  "image/png": { ext: "png", kind: "IMAGE" },
  "image/webp": { ext: "webp", kind: "IMAGE" },
  "audio/webm": { ext: "webm", kind: "AUDIO" },
  "audio/ogg": { ext: "ogg", kind: "AUDIO" },
  "audio/mp4": { ext: "m4a", kind: "AUDIO" },
  "audio/mpeg": { ext: "mp3", kind: "AUDIO" },
  "audio/wav": { ext: "wav", kind: "AUDIO" },
};

// Photos and voice notes sent inside a chat (memory storage, like profile photos).
export const uploadChatMedia = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
}).single("file");
