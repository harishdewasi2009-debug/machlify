const express = require('express');
const { one, query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { publicUser } = require('./auth');

const router = express.Router();

function matchKey(a, b) {
  return a < b ? [a, b] : [b, a];
}

// Record a swipe. If mutual like/superlike exists, create a match.
router.post('/', requireAuth, async (req, res) => {
  try {
    const { targetId, action } = req.body;
    if (!targetId || !['like', 'pass', 'superlike'].includes(action)) {
      return res.status(400).json({ error: 'targetId and a valid action are required' });
    }
    if (Number(targetId) === req.userId) {
      return res.status(400).json({ error: 'Cannot swipe on yourself' });
    }
    const target = await one('SELECT id FROM users WHERE id = $1', [targetId]);
    if (!target) return res.status(404).json({ error: 'Target user not found' });

    await query(
      `INSERT INTO swipes (swiper_id, target_id, action) VALUES ($1,$2,$3)
       ON CONFLICT (swiper_id, target_id) DO UPDATE SET action = EXCLUDED.action`,
      [req.userId, targetId, action]
    );

    let match = null;
    if (action === 'like' || action === 'superlike') {
      const reciprocal = await one(
        `SELECT * FROM swipes WHERE swiper_id = $1 AND target_id = $2 AND action IN ('like','superlike')`,
        [targetId, req.userId]
      );
      if (reciprocal) {
        const [a, b] = matchKey(req.userId, Number(targetId));
        await query(
          `INSERT INTO matches (user_a, user_b) VALUES ($1,$2) ON CONFLICT (user_a, user_b) DO NOTHING`,
          [a, b]
        );
        const row = await one('SELECT * FROM matches WHERE user_a = $1 AND user_b = $2', [a, b]);
        const otherUser = await one('SELECT * FROM users WHERE id = $1', [targetId]);
        match = { id: row.id, createdAt: row.created_at, user: publicUser(otherUser) };
      }
    }

    res.json({ ok: true, match });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not record swipe' });
  }
});

module.exports = router;
