import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import fs from "node:fs/promises";
import path from "node:path";
import { env, s3Configured } from "../config/env";
import { Errors } from "../utils/apiError";

// Works against real AWS S3 (leave S3_ENDPOINT blank) or an S3-compatible
// provider like Cloudflare R2 (set S3_ENDPOINT to the R2 account endpoint).
const client = s3Configured
  ? new S3Client({
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT || undefined,
      credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
      forcePathStyle: Boolean(env.S3_ENDPOINT), // required by R2 and most non-AWS S3-compatible endpoints
    })
  : null;

// Local-disk fallback when S3 is not configured. Note: Render's disk is ephemeral
// unless a persistent disk is attached, so use S3/R2 for real production data.
export const localUploadRoot = path.resolve(env.UPLOAD_DIR);
function localPath(key: string) {
  const full = path.resolve(localUploadRoot, key);
  if (!full.startsWith(localUploadRoot + path.sep)) throw Errors.validation("Invalid storage key.");
  return full;
}

function assertConfigured() {
  if (!client) throw Errors.configurationMissing("Object storage");
}

export async function putObject(key: string, body: Buffer, contentType: string): Promise<void> {
  if (!client) {
    const file = localPath(key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, body);
    return;
  }
  await client!.send(
    new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
      // Private by default. Photos are served through getPhotoUrl (either a
      // public CDN base URL, or a short-lived signed URL) — never a
      // permanently public bucket unless S3_PUBLIC_BASE_URL is explicitly set.
    })
  );
}

export async function deleteObject(key: string): Promise<void> {
  if (!client) {
    await fs.rm(localPath(key), { force: true });
    return;
  }
  await client!.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
}

// Returns a URL the frontend can load an image from directly. If
// S3_PUBLIC_BASE_URL is configured (bucket/CDN is public), build a plain
// URL; otherwise generate a short-lived signed URL so private storage
// credentials are never exposed to the client.
export async function getObjectUrl(key: string): Promise<string> {
  if (!client) return `${env.APP_ORIGIN.replace(/\/$/, "")}/uploads/${key}`;
  if (env.S3_PUBLIC_BASE_URL) {
    return `${env.S3_PUBLIC_BASE_URL.replace(/\/$/, "")}/${key}`;
  }
  const command = new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key });
  return getSignedUrl(client!, command, { expiresIn: 60 * 15 }); // 15 minutes
}

export function buildPhotoKey(userId: string, photoId: string, variant: "original" | "large" | "medium" | "thumbnail") {
  return `users/${userId}/photos/${photoId}/${variant}`;
}

// Verification selfies live under a separate top-level prefix from regular
// profile photos — they are never part of the public discovery photo
// pipeline, are never given a public URL even when S3_PUBLIC_BASE_URL is
// set for regular photos (getVerificationSelfieUrl below always
// signs), and are only ever fetched by their own owner or by an
// authenticated admin/moderator reviewing the verification queue.
export function buildVerificationSelfieKey(userId: string, sessionId: string) {
  return `verification/${userId}/${sessionId}`;
}

export async function getVerificationSelfieUrl(key: string): Promise<string> {
  // Local mode: selfies are never served statically (only users/ is), so there is no URL to hand out.
  if (!client) throw Errors.configurationMissing("Object storage (verification selfie viewing)");
  const command = new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key });
  return getSignedUrl(client!, command, { expiresIn: 60 * 15 }); // 15 minutes, always signed — never public
}
