require('dotenv').config();
const http = require('http');
const cfg = require('./config');
const logger = require('./lib/logger');

if (!process.env.JWT_SECRET) { console.error('Missing JWT_SECRET. Copy .env.example to .env and set it.'); process.exit(1); }
if (!process.env.REFRESH_SECRET) process.env.REFRESH_SECRET = process.env.JWT_SECRET + ':refresh';
try { cfg.assertProductionSafe(); } catch (e) { console.error(e.message); process.exit(1); }

const db = require('./db');
const { createApp } = require('./app');
const socket = require('./socket');
const jobs = require('./jobs');

const PORT = process.env.PORT || 4000;
const app = createApp();
const server = http.createServer(app);
const io = socket.attach(server);

db.init()
  .then(() => {
    server.listen(PORT, () => {
      logger.info(`${cfg.BRAND_NAME} running on http://localhost:${PORT} (${cfg.isProd() ? 'production' : 'development'}${cfg.demoVisible() ? ', DEMO_MODE on' : ''})`);
    });
    jobs.start();
  })
  .catch((err) => { console.error('Failed to initialise database:', err.message); process.exit(1); });

function shutdown(sig) {
  logger.info(`${sig} received, shutting down`);
  jobs.stop();
  io.close(() => server.close(() => db.pool.end().then(() => process.exit(0))));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
