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
