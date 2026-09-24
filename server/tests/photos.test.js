const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const h = require('./helpers');
const storage = require('../lib/storage');
const { moderateImage } = require('../lib/imageModeration');
const { request, app } = h;

test.before(h.setup);
test.after(h.teardown);
test.beforeEach(async () => { await h.resetDb(); });

const img = (w = 900, h_ = 1200, color = { r: 200, g: 60, b: 90 }) => sharp({ create: { width: w, height: h_, channels: 3, background: color } }).jpeg().toBuffer();
const upload = (u, buf, name = 'p.jpg', type = 'image/jpeg') => request(app).post('/api/photos').set('Authorization', 'Bearer ' + u.token).attach('photo', buf, { filename: name, contentType: type });
const withEnv = async (env, fn) => { const old = {}; for (const k of Object.keys(env)) { old[k] = process.env[k]; process.env[k] = env[k]; } try { return await fn(); } finally { for (const k of Object.keys(old)) old[k] === undefined ? delete process.env[k] : (process.env[k] = old[k]); } };

test('upload: content-validated, EXIF/GPS stripped, resized, thumbnail made, profile updated', async () => {
  const u = await h.createUser({ noPhotos: true });
  const withExif = await sharp(await img(3000, 2000)).withExif({ IFD0: { ImageDescription: 'GPS-SECRET-HOME-ADDRESS' } }).jpeg().toBuffer();
  assert.ok(withExif.includes(Buffer.from('GPS-SECRET-HOME-ADDRESS')), 'test image really carries EXIF');
  const r = await upload(u, withExif);
  assert.strictEqual(r.status, 201, JSON.stringify(r.body)); assert.strictEqual(r.body.photo.status, 'approved');
  const key = (await h.db.query('SELECT storage_key, width FROM photos')).rows[0];
  const file = fs.readFileSync(path.join(storage.LOCAL_DIR, key.storage_key));
  assert.ok(!file.includes(Buffer.from('GPS-SECRET-HOME-ADDRESS')), 'EXIF removed from the stored file');
  const meta = await sharp(file).metadata(); assert.ok(meta.width <= 1600 && !meta.exif, `resized (${meta.width}px) and no EXIF`);
  assert.ok(fs.existsSync(path.join(storage.LOCAL_DIR, key.storage_key.replace('.jpg', '_t.jpg'))), 'thumbnail');
  assert.strictEqual(JSON.parse((await h.fresh(u.id)).photos).length, 1);
  assert.ok((await h.fresh(u.id)).profile_strength > 0);
  const served = await request(app).get(r.body.photo.url); assert.strictEqual(served.status, 200); assert.strictEqual(served.headers['x-content-type-options'], 'nosniff');
});

test('rejects non-images, spoofed extensions, tiny images, oversize files; needs auth', async () => {
  const u = await h.createUser({ noPhotos: true });
  assert.strictEqual((await upload(u, Buffer.from('<script>alert(1)</script>'), 'x.jpg')).status, 400);
  assert.strictEqual((await upload(u, Buffer.from('%PDF-1.4 fake'), 'x.jpg')).status, 400);
  assert.strictEqual((await upload(u, await sharp(await img(300, 300)).gif().toBuffer(), 'x.gif', 'image/gif')).status, 400, 'GIF not accepted');
  assert.strictEqual((await upload(u, await img(100, 100))).status, 400, 'too small');
  assert.strictEqual((await upload(u, Buffer.alloc(9 * 1024 * 1024, 1))).status, 413);
  assert.strictEqual((await request(app).post('/api/photos').attach('photo', await img(), 'p.jpg')).status, 401);
  assert.strictEqual((await request(app).post('/api/photos').set('Authorization', 'Bearer ' + u.token)).status, 400, 'no file');
  const png = await sharp({ create: { width: 500, height: 500, channels: 3, background: '#0f0' } }).png().toBuffer();
  assert.strictEqual((await upload(u, png, 'weird.dat', 'application/octet-stream')).status, 201, 'valid PNG accepted regardless of the client-claimed type');
  assert.strictEqual((await h.db.query('SELECT COUNT(*) c FROM photos')).rows[0].c, '1');
});

test('at most 9 photos; delete removes files; reorder and set-primary work', async () => {
  const u = await h.createUser({ noPhotos: true }); const ids = [];
  for (let i = 0; i < 9; i++) { const r = await upload(u, await img(600 + i, 800, { r: i * 20, g: 90, b: 200 - i * 10 })); assert.strictEqual(r.status, 201); ids.push(r.body.photo.id); }
  assert.strictEqual((await upload(u, await img(700, 900, { r: 1, g: 2, b: 3 }))).status, 400, 'tenth photo refused');
  const key = (await h.db.query('SELECT storage_key FROM photos WHERE id=$1', [ids[8]])).rows[0].storage_key;
  assert.strictEqual((await h.as(u).delete(`/api/photos/${ids[8]}`)).status, 200);
  assert.ok(!fs.existsSync(path.join(storage.LOCAL_DIR, key)), 'file deleted from storage');
  const order = [ids[3], ids[0], ids[1], ids[2], ids[4], ids[5], ids[6], ids[7]];
  assert.deepStrictEqual((await h.as(u).put('/api/photos/order', { ids: order })).body.photos.map((p) => p.id), order);
  assert.strictEqual((await h.as(u).post(`/api/photos/${ids[7]}/primary`)).body.photos[0].id, ids[7]);
  const other = await h.createUser({ noPhotos: true });
  assert.strictEqual((await h.as(other).delete(`/api/photos/${ids[0]}`)).status, 404, "cannot delete someone else's photo");
  assert.strictEqual((await h.as(other).put('/api/photos/order', { ids })).status, 400);
});

test('production without an image-moderation provider sends every photo to human review (hidden until approved)', async () => {
  const u = await h.createUser({ noPhotos: true });
  await withEnv({ NODE_ENV: 'production' }, async () => {
    const r = await upload(u, await img());
    assert.strictEqual(r.body.photo.status, 'needs_review');
  });
  assert.deepStrictEqual(JSON.parse((await h.fresh(u.id)).photos), [], 'not public');
  assert.strictEqual((await moderateImage(await img())).status, 'approved', 'dev/test auto-approves');
  await withEnv({ IMAGE_MODERATION_PROVIDER: 'sightengine', SIGHTENGINE_USER: '', SIGHTENGINE_SECRET: '' }, async () => assert.strictEqual((await moderateImage(await img())).status, 'needs_review', 'misconfigured provider fails safe'));
});

test('the same photo on a second account raises a duplicate-photo risk signal (perceptual hash)', async () => {
  const [a, b, c] = [await h.createUser({ noPhotos: true }), await h.createUser({ noPhotos: true }), await h.createUser({ noPhotos: true })];
  const pic = await sharp({ create: { width: 800, height: 800, channels: 3, background: '#223' } }).composite([{ input: Buffer.from('<svg width="800" height="800"><circle cx="300" cy="300" r="200" fill="#f90"/><rect x="450" y="420" width="250" height="300" fill="#0af"/></svg>') }]).jpeg().toBuffer();
  await upload(a, pic);
  assert.strictEqual((await h.db.query(`SELECT COUNT(*) c FROM risk_signals WHERE signal='duplicate_photo'`)).rows[0].c, '0');
  const recompressed = await sharp(pic).resize(640).jpeg({ quality: 60 }).toBuffer();     // re-encoded copy, still "the same photo"
  await upload(b, recompressed);
  const sig = await h.db.query(`SELECT user_id, meta FROM risk_signals WHERE signal='duplicate_photo'`);
  assert.strictEqual(sig.rowCount, 1); assert.strictEqual(sig.rows[0].user_id, b.id); assert.strictEqual(sig.rows[0].meta.matchesUser, a.id);
  await upload(c, await sharp({ create: { width: 800, height: 800, channels: 3, background: '#000' } }).composite([{ input: Buffer.from('<svg width="800" height="800"><polygon points="0,800 800,0 800,800" fill="#fff"/></svg>') }]).jpeg().toBuffer());
  assert.strictEqual((await h.db.query(`SELECT COUNT(*) c FROM risk_signals WHERE signal='duplicate_photo'`)).rows[0].c, '1', 'unrelated photo is not flagged');
});
