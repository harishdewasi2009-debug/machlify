const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const crypto = require('crypto');
const { one, many, query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const limits = require('../middleware/limits');
const { HttpError, asyncHandler } = require('../lib/util');
const { MAX_PROFILE_PHOTOS } = require('../config');
const storage = require('../lib/storage');
const { moderateImage } = require('../lib/imageModeration');
const { recordSignal } = require('../lib/risk');
const { refreshProfile, loadPhotoItems } = require('../services/profile');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });

// 64-bit difference hash → signed BIGINT (Postgres has no unsigned 64).
async function dHash(buffer) {
  const { data } = await sharp(buffer).grayscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  let bits = 0n;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    bits = (bits << 1n) | (data[y * 9 + x] > data[y * 9 + x + 1] ? 1n : 0n);
  }
  return BigInt.asIntN(64, bits);
}

router.get('/', requireAuth, asyncHandler(async (req, res) => {
  res.json({ photos: await loadPhotoItems(req.userId), max: MAX_PROFILE_PHOTOS });
}));

router.post('/', requireAuth, limits.upload, upload.single('photo'), asyncHandler(async (req, res) => {
  if (!req.file) throw new HttpError(400, 'Attach an image in the "photo" field.');
  const count = Number((await one(`SELECT COUNT(*) c FROM photos WHERE user_id=$1 AND status <> 'rejected'`, [req.userId])).c);
  if (count >= MAX_PROFILE_PHOTOS) throw new HttpError(400, `A profile can have at most ${MAX_PROFILE_PHOTOS} photos`);

  let main, thumb, hash, meta;
  try {
    meta = await sharp(req.file.buffer).metadata();             // validates by CONTENT, not the client's MIME claim
    if (!['jpeg', 'png', 'webp'].includes(meta.format)) throw new Error('unsupported');
    if ((meta.width || 0) < 200 || (meta.height || 0) < 200) throw new HttpError(400, 'Image is too small (minimum 200×200).');
    const pipeline = () => sharp(req.file.buffer, { limitInputPixels: 60e6 }).rotate();  // applies EXIF orientation; output carries NO metadata (EXIF/GPS stripped)
    main = await pipeline().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82, mozjpeg: true }).toBuffer();
    thumb = await pipeline().resize({ width: 400, height: 400, fit: 'cover' }).jpeg({ quality: 76 }).toBuffer();
    hash = await dHash(main);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, 'That file is not a valid JPEG, PNG or WebP image.');
  }

  const mod = await moderateImage(main, 'image/jpeg');
  const id = crypto.randomBytes(12).toString('hex');
  const key = `u${req.userId}/${id}.jpg`, tkey = `u${req.userId}/${id}_t.jpg`;
  let url = 'rejected', thumbUrl = null;
  if (mod.status !== 'rejected') {
    url = await storage.put(key, main, 'image/jpeg');
    thumbUrl = await storage.put(tkey, thumb, 'image/jpeg');
  }
  const row = await one(
    `INSERT INTO photos (user_id, url, thumb_url, storage_key, position, status, moderation, phash, width, height)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [req.userId, url, thumbUrl, mod.status === 'rejected' ? null : key, count, mod.status, JSON.stringify(mod.labels || {}), hash.toString(), meta.width, meta.height]);

  // Reused photo across accounts → fake-profile signal.
  const dup = await one(
    `SELECT user_id FROM photos WHERE user_id <> $1 AND phash IS NOT NULL AND status IN ('approved','needs_review')
       AND bit_count(((phash # $2::bigint)::bigint)::bit(64)) <= 5 LIMIT 1`, [req.userId, hash.toString()]);
  if (dup) await recordSignal(req.userId, 'duplicate_photo', { matchesUser: dup.user_id, photoId: row.id });

  await refreshProfile(req.userId);
  res.status(201).json({
    photo: { id: row.id, url: row.url, thumb: row.thumb_url, status: row.status, position: row.position },
    message: mod.status === 'approved' ? 'Photo added.' : mod.status === 'needs_review' ? 'Photo uploaded and waiting for review.' : 'This photo was rejected because it breaks our community guidelines.',
  });
}));

router.delete('/:id', requireAuth, asyncHandler(async (req, res) => {
  const p = await one('SELECT * FROM photos WHERE id=$1 AND user_id=$2', [req.params.id, req.userId]);
  if (!p) throw new HttpError(404, 'Photo not found');
  await query('DELETE FROM photos WHERE id=$1', [p.id]);
  await storage.remove(p.storage_key); if (p.storage_key) await storage.remove(p.storage_key.replace('.jpg', '_t.jpg'));
  await refreshProfile(req.userId);
  res.json({ ok: true, photos: await loadPhotoItems(req.userId) });
}));

router.put('/order', requireAuth, asyncHandler(async (req, res) => {
  const ids = (req.body?.ids || []).map(Number);
  const mine = (await many('SELECT id FROM photos WHERE user_id=$1', [req.userId])).map((r) => r.id);
  if (!ids.length || ids.some((i) => !mine.includes(i))) throw new HttpError(400, 'ids must be your photo ids');
  for (let i = 0; i < ids.length; i++) await query('UPDATE photos SET position=$3 WHERE id=$1 AND user_id=$2', [ids[i], req.userId, i]);
  await refreshProfile(req.userId);
  res.json({ photos: await loadPhotoItems(req.userId) });
}));

router.post('/:id/primary', requireAuth, asyncHandler(async (req, res) => {
  const items = await loadPhotoItems(req.userId);
  const id = Number(req.params.id);
  if (!items.some((p) => p.id === id)) throw new HttpError(404, 'Photo not found');
  const order = [id, ...items.filter((p) => p.id !== id).map((p) => p.id)];
  for (let i = 0; i < order.length; i++) await query('UPDATE photos SET position=$3 WHERE id=$1 AND user_id=$2', [order[i], req.userId, i]);
  await refreshProfile(req.userId);
  res.json({ photos: await loadPhotoItems(req.userId) });
}));

module.exports = { router, dHash };
