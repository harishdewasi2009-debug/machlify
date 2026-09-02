const express = require('express');
const { one, many, query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { publicUser } = require('./auth');

const router = express.Router();

function otherUserId(match, myId) {
  return match.user_a === myId ? match.user_b : match.user_a;
}

function assertParticipant(match, userId, res) {
  if (!match || (match.user_a !== userId && match.user_b !== userId)) {
    res.status(404).json({ error: 'Match not found' });
    return false;
  }
  return true;
}

// List my matches, each with the other user + last message preview
router.get('/', requireAuth, async (req, res) => {
  try {
    const rows = await many(
      `SELECT * FROM matches WHERE user_a = $1 OR user_b = $1 ORDER BY created_at DESC`,
      [req.userId]
    );

    const matches = await Promise.all(rows.map(async (m) => {
      const otherId = otherUserId(m, req.userId);
      const other = await one('SELECT * FROM users WHERE id = $1', [otherId]);
      const lastMsg = await one(
        `SELECT * FROM messages WHERE match_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [m.id]
      );
      const unread = await one(
        `SELECT COUNT(*) as c FROM messages WHERE match_id = $1 AND sender_id != $2 AND read = false`,
        [m.id, req.userId]
      );
      return {
        id: m.id,
        createdAt: m.created_at,
        user: publicUser(other),
        lastMessage: lastMsg ? { text: lastMsg.text, senderId: lastMsg.sender_id, createdAt: lastMsg.created_at, type: lastMsg.type } : null,
        unreadCount: parseInt(unread.c, 10),
      };
    }));
    res.json({ matches });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load matches' });
  }
});

// Get messages for a match (marks incoming as read)
router.get('/:id/messages', requireAuth, async (req, res) => {
  const match = await one('SELECT * FROM matches WHERE id = $1', [req.params.id]);
  if (!assertParticipant(match, req.userId, res)) return;

  await query(`UPDATE messages SET read = true WHERE match_id = $1 AND sender_id != $2`, [match.id, req.userId]);

  const msgs = await many(`SELECT * FROM messages WHERE match_id = $1 ORDER BY created_at ASC`, [match.id]);
  res.json({
    messages: msgs.map(m => ({
      id: m.id, text: m.text, senderId: m.sender_id, createdAt: m.created_at, read: !!m.read, type: m.type || 'text',
    })),
  });
});

// Send a message in a match
router.post('/:id/messages', requireAuth, async (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'Message text is required' });
  const match = await one('SELECT * FROM matches WHERE id = $1', [req.params.id]);
  if (!assertParticipant(match, req.userId, res)) return;

  const msg = await one(
    `INSERT INTO messages (match_id, sender_id, text, type) VALUES ($1,$2,$3,'text') RETURNING *`,
    [match.id, req.userId, text.trim()]
  );
  res.status(201).json({ message: { id: msg.id, text: msg.text, senderId: msg.sender_id, createdAt: msg.created_at, read: !!msg.read, type: msg.type } });
});

// Log a call (called by the client when a call ends, so it shows up in chat history)
router.post('/:id/calls', requireAuth, async (req, res) => {
  const { calleeId, callType, status, durationSeconds } = req.body;
  const match = await one('SELECT * FROM matches WHERE id = $1', [req.params.id]);
  if (!assertParticipant(match, req.userId, res)) return;
  if (!['audio', 'video'].includes(callType)) return res.status(400).json({ error: 'callType must be audio or video' });

  const call = await one(
    `INSERT INTO calls (match_id, caller_id, callee_id, call_type, status, ended_at, duration_seconds)
     VALUES ($1,$2,$3,$4,$5, NOW(), $6) RETURNING *`,
    [match.id, req.userId, calleeId, callType, status || 'completed', durationSeconds || 0]
  );

  const icon = callType === 'video' ? '🎥' : '📞';
  const label = status === 'missed' ? 'Missed call' : `${callType === 'video' ? 'Video' : 'Audio'} call · ${formatDuration(durationSeconds || 0)}`;
  const msg = await one(
    `INSERT INTO messages (match_id, sender_id, text, type) VALUES ($1,$2,$3,'call') RETURNING *`,
    [match.id, req.userId, `${icon} ${label}`]
  );

  res.status(201).json({ call, message: { id: msg.id, text: msg.text, senderId: msg.sender_id, createdAt: msg.created_at, type: msg.type } });
});

function formatDuration(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Unmatch
router.delete('/:id', requireAuth, async (req, res) => {
  const match = await one('SELECT * FROM matches WHERE id = $1', [req.params.id]);
  if (!assertParticipant(match, req.userId, res)) return;
  await query('DELETE FROM matches WHERE id = $1', [match.id]);
  res.json({ ok: true });
});

module.exports = router;
