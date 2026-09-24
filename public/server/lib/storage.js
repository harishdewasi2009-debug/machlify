// Photo storage adapter. STORAGE_DRIVER=local (default; ./uploads, served at
// /uploads) or s3 (any S3-compatible: AWS S3, Cloudflare R2, MinIO).
const fs = require('fs');
const path = require('path');

const LOCAL_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
let s3 = null;

function driver() { return (process.env.STORAGE_DRIVER || 'local').toLowerCase(); }

function s3client() {
  if (s3) return s3;
  const { S3Client } = require('@aws-sdk/client-s3');
  s3 = new S3Client({
    region: process.env.S3_REGION || 'auto',
    endpoint: process.env.S3_ENDPOINT || undefined,
    credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY },
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
  });
  return s3;
}

async function put(key, buffer, contentType) {
  if (driver() === 's3') {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    await s3client().send(new PutObjectCommand({
      Bucket: process.env.S3_BUCKET, Key: key, Body: buffer, ContentType: contentType, CacheControl: 'public, max-age=31536000, immutable',
    }));
    const base = (process.env.S3_PUBLIC_URL || '').replace(/\/$/, '');
    return `${base}/${key}`;
  }
  const file = path.join(LOCAL_DIR, key);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, buffer);
  return `/uploads/${key}`;
}

async function remove(key) {
  if (!key) return;
  try {
    if (driver() === 's3') {
      const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
      await s3client().send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }));
    } else {
      await fs.promises.unlink(path.join(LOCAL_DIR, key));
    }
  } catch (e) { /* already gone */ }
}

module.exports = { put, remove, LOCAL_DIR, driver };
