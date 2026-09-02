require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');

const db = require('./db');
const { initSocket } = require('./socket');
const { router: authRouter } = require('./routes/auth');
const usersRouter = require('./routes/users');
const swipesRouter = require('./routes/swipes');
const matchesRouter = require('./routes/matches');
const aiRouter = require('./routes/ai');

if (!process.env.JWT_SECRET) {
  console.error('Missing JWT_SECRET in environment (.env file). Copy .env.example to .env and set a secret.');
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);
app.use('/api/swipes', swipesRouter);
app.use('/api/matches', matchesRouter);
app.use('/api/ai', aiRouter);

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Serve frontend (including manifest.json + service worker for the desktop "install" flow)
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));
app.get('*', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

const PORT = process.env.PORT || 4000;
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
initSocket(io);

db.init()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Matchify server running on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
