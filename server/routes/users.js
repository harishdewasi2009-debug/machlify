const express = require('express');
const { one, many, query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { publicUser } = require('./auth');

const router = express.Router();

// Update own profile
router.put('/me', requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const current = await one('SELECT * FROM users WHERE id = $1', [req.userId]);
    if (!current) return res.status(404).json({ error: 'User not found' });

    const next = {
      name: body.name ?? current.name,
      age: body.age ?? current.age,
      gender: body.gender ?? current.gender,
      interested_in: body.interestedIn ?? current.interested_in,
      bio: body.bio ?? current.bio,
      job: body.job ?? current.job,
      location: body.location ?? current.location,
      country: body.country ?? current.country,
      interests: body.interests ? JSON.stringify(body.interests) : current.interests,
      photos: body.photos ? JSON.stringify(body.photos) : current.photos,
    };

    const updated = await one(
      `UPDATE users SET name=$1, age=$2, gender=$3, interested_in=$4, bio=$5, job=$6,
       location=$7, country=$8, interests=$9, photos=$10
       WHERE id=$11 RETURNING *`,
      [next.name, next.age, next.gender, next.interested_in, next.bio, next.job,
       next.location, next.country, next.interests, next.photos, req.userId]
    );
    res.json({ user: publicUser(updated) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not update profile' });
  }
});

// Discover feed: users not yet swiped on by me, excluding self
router.get('/discover', requireAuth, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
  const rows = await many(
    `SELECT u.* FROM users u
     WHERE u.id != $1
       AND u.id NOT IN (SELECT target_id FROM swipes WHERE swiper_id = $1)
     ORDER BY RANDOM()
     LIMIT $2`,
    [req.userId, limit]
  );
  res.json({ profiles: rows.map(publicUser) });
});

// Mock subscription — no real payment gateway wired up yet.
// Plug Razorpay in here later: verify payment signature, THEN call this update.
// Tiers: free (₹0) / plus (₹49/mo) / pro (₹99/mo) / ultra (₹199/mo) — all billed monthly.
const PLANS = ['free', 'plus', 'pro', 'ultra'];
router.post('/subscribe', requireAuth, async (req, res) => {
  const { plan } = req.body;
  if (!PLANS.includes(plan)) {
    return res.status(400).json({ error: `plan must be one of: ${PLANS.join(', ')}` });
  }
  const expires = plan === 'free' ? null : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const premium = plan !== 'free';
  const updated = await one(
    `UPDATE users SET premium=$1, plan=$2, plan_expires_at=$3 WHERE id=$4 RETURNING *`,
    [premium, plan, expires, req.userId]
  );
  res.json({ user: publicUser(updated) });
});

// Public profile by id
router.get('/:id', requireAuth, async (req, res) => {
  const user = await one('SELECT * FROM users WHERE id = $1', [req.params.id]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user: publicUser(user) });
});

module.exports = router;
