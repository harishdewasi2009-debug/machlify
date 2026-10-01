import crypto from "node:crypto";
import sharp from "sharp";
import { Errors } from "../utils/apiError";

export type ImageFormat = "jpeg" | "png" | "webp";

const MIN_DIMENSION = 200;
const MAX_DIMENSION = 6000;

// Check actual file signatures (magic bytes) rather than trusting the
// browser-supplied Content-Type or the filename extension — both are
// trivially spoofable by a malicious client.
function sniffFormat(buffer: Buffer): ImageFormat | null {
  if (buffer.length < 12) return null;

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpeg";

  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "png";
  }

  if (
    buffer.slice(0, 4).toString("ascii") === "RIFF" &&
    buffer.slice(8, 12).toString("ascii") === "WEBP"
  ) {
    return "webp";
  }

  return null;
}

export interface ImageVariant {
  buffer: Buffer;
  width: number;
  height: number;
}

export interface ProcessedImage {
  format: ImageFormat;
  contentHash: string; // for duplicate-image detection
  original: ImageVariant;
  large: ImageVariant;
  medium: ImageVariant;
  thumbnail: ImageVariant;
}

async function resizeVariant(pipeline: sharp.Sharp, maxDimension: number): Promise<ImageVariant> {
  // .rotate() with no args auto-orients from EXIF, then we re-encode without
  // calling .withMetadata() — this is what actually strips EXIF/GPS/ICC data,
  // not just hiding it. Re-encoding through libvips also neutralizes most
  // malformed-image exploit payloads that rely on the original byte stream.
  const buffer = await pipeline
    .clone()
    .rotate()
    .resize({ width: maxDimension, height: maxDimension, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer();

  const meta = await sharp(buffer).metadata();
  return { buffer, width: meta.width ?? 0, height: meta.height ?? 0 };
}

// Throws a validation ApiError for anything that isn't a genuine, decodable
// JPEG/PNG/WebP within acceptable dimensions. Never trust the upload past
// this point without having gone through here first.
export async function processUploadedImage(raw: Buffer): Promise<ProcessedImage> {
  const format = sniffFormat(raw);
  if (!format) {
    throw Errors.validation("File is not a recognized JPEG, PNG, or WebP image.");
  }

  let metadata: sharp.Metadata;
  try {
    // Actually decoding the image (not just reading headers) is the real
    // content validation — a corrupt or booby-trapped file fails here.
    metadata = await sharp(raw).metadata();
  } catch {
    throw Errors.validation("File could not be decoded as a valid image.");
  }

  if (!metadata.width || !metadata.height) {
    throw Errors.validation("File could not be decoded as a valid image.");
  }

  if (metadata.width < MIN_DIMENSION || metadata.height < MIN_DIMENSION) {
    throw Errors.validation(`Image must be at least ${MIN_DIMENSION}x${MIN_DIMENSION}px.`);
  }
  if (metadata.width > MAX_DIMENSION || metadata.height > MAX_DIMENSION) {
    throw Errors.validation(`Image must be at most ${MAX_DIMENSION}x${MAX_DIMENSION}px.`);
  }

  const pipeline = sharp(raw);

  const [original, large, medium, thumbnail] = await Promise.all([
    resizeVariant(pipeline, 2400),
    resizeVariant(pipeline, 1600),
    resizeVariant(pipeline, 800),
    resizeVariant(pipeline, 300),
  ]);

  // Hash the "large" variant (post-resize, post-metadata-strip) rather than
  // the raw upload, so trivial re-encodes of the same photo still collide.
  const contentHash = crypto.createHash("sha256").update(large.buffer).digest("hex");

  return { format, contentHash, original, large, medium, thumbnail };
}
