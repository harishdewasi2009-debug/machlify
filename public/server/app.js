const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const path = require('path');
const pinoHttp = require('pino-http');
const cfg = require('./config');
const logger = require('./lib/logger');
const { HttpError } = require('./lib/util');
const db = require('./db');
const storage = require('./lib/storage');
const limits = require('./middleware/limits');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY : 1);

  if (process.env.NODE_ENV !== 'test') app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/api/health' } }));

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://accounts.google.com', 'https://checkout.razorpay.com'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://accounts.google.com'],
        imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
        connectSrc: ["'self'", 'ws:', 'wss:', 'https://accounts.google.com', 'https://lumberjack.razorpay.com', 'https://api.razorpay.com'],
        frameSrc: ["'self'", 'https://accounts.google.com', 'https://api.razorpay.com', 'https://checkout.razorpay.com'],
        mediaSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"], frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false, crossOriginResourcePolicy: { policy: 'same-site' },
  }));
  app.use(cors({ origin: process.env.APP_ORIGIN || false, credentials: true }));
  app.use(cookieParser());

  // Webhooks need the EXACT raw bytes for signature checks → parse raw BEFORE express.json().
  app.use('/api/payments/webhook', express.raw({ type: '*/*', limit: '256kb' }));
  app.use('/api/verification/webhook', express.raw({ type: '*/*', limit: '256kb' }));
  app.use(express.json({ limit: '100kb' }));

  app.use('/api', limits.general);

  app.use('/api/auth', require('./routes/auth').router);
  app.use('/api/users', require('./routes/users').router);
  app.use('/api/photos', require('./routes/photos').router);
  app.use('/api/swipes', require('./routes/swipes').router);
  app.use('/api/matches', require('./routes/matches').router);
  app.use('/api/ai', require('./routes/ai').router);
  app.use('/api/safety', require('./routes/safety').router);
  app.use('/api/notifications', require('./routes/notifications').router);
  app.use('/api/verification', require('./routes/verification').router);
  app.use('/api/payments', require('./routes/payments').router);
  app.use('/api/admin', require('./routes/admin').router);
  app.use('/api/config', require('./routes/config').router);

  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.get('/api/ready', async (req, res) => {
    try { await db.query('SELECT 1'); res.json({ ok: true, db: true }); } catch (e) { res.status(503).json({ ok: false, db: false }); }
  });

  // Locally-stored uploads (STORAGE_DRIVER=local). Served as inert images only.
  app.use('/uploads', express.static(storage.LOCAL_DIR, { maxAge: '365d', immutable: true, setHeaders: (res) => { res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Content-Disposition', 'inline'); } }));

  // Synthetic demo avatars (CC0 illustration styles), generated on demand. Never real people.
  const DEMO_STYLES = new Set(['lorelei', 'thumbs', 'shapes', 'notionists']);
  const avatarCache = new Map();
  app.get('/demo-avatars/:style/:seed.svg', async (req, res) => {
    const { style, seed } = req.params;
    if (!DEMO_STYLES.has(style) || !/^[A-Za-z0-9_-]{1,64}$/.test(seed)) return res.status(404).end();
    try {
      const key = style + '/' + seed;
      if (!avatarCache.has(key)) {
        const [{ createAvatar }, col] = await Promise.all([import('@dicebear/core'), import('@dicebear/collection')]);
        avatarCache.set(key, createAvatar(col[style], { seed, size: 512 }).toString());
        if (avatarCache.size > 3000) avatarCache.delete(avatarCache.keys().next().value);
      }
      res.type('image/svg+xml').set('Cache-Control', 'public, max-age=31536000, immutable').send(avatarCache.get(key));
    } catch (e) { res.status(500).end(); }
  });

  const publicDir = path.join(__dirname, '..', 'public');
  app.use(express.static(publicDir, { extensions: ['html'] }));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  app.get('*', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));

  // ---- error handler ----
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
    if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File is too large (max 8 MB).' });
    if (err && err.name === 'MulterError') return res.status(400).json({ error: err.message });
    if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large')) return res.status(err.status || 400).json({ error: 'Invalid request body' });
    logger.error({ err: err && err.stack, url: req.originalUrl }, 'unhandled error');
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });
  return app;
}
module.exports = { createApp };
