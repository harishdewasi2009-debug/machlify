const express = require('express');
const jwt = require('jsonwebtoken');
const { one, query } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    age: u.age,
    gender: u.gender,
    interestedIn: u.interested_in,
    bio: u.bio,
    job: u.job,
    location: u.location,
    country: u.country,
    interests: u.interests ? JSON.parse(u.interests) : [],
    photos: u.photos ? JSON.parse(u.photos) : [],
    verified: !!u.verified,
    premium: !!u.premium,
    plan: u.plan || 'free',
    planExpiresAt: u.plan_expires_at,
    authProvider: u.auth_provider || 'local',
  };
}

function sign(user) {
  return jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '30d' });
}

// ---- Demo session ----
// There is no sign-in flow. Every visitor is handed the same shared demo
// account so the rest of the app (matches, swipes, chat, calls) still has a
// consistent user to attach data to. First call creates it, later calls
// reuse it.
const DEMO_EMAIL = 'you@matchify.app';

router.post('/demo', async (req, res) => {
  try {
    let user = await one('SELECT * FROM users WHERE email = $1', [DEMO_EMAIL]);
    if (!user) {
      user = await one(
        `INSERT INTO users (email, password_hash, auth_provider, name, age, gender, interested_in, bio, job, location, country, interests, photos, verified)
         VALUES ($1, NULL, 'demo', 'You', 27, 'nonbinary', 'everyone', 'Just here to explore Matchify.', '', '', '', '[]', '[]', true)
         RETURNING *`,
        [DEMO_EMAIL]
      );
    }
    await query('UPDATE users SET is_online = true WHERE id = $1', [user.id]);
    res.json({ token: sign(user), user: publicUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not start demo session' });
  }
});

router.get('/me', requireAuth, async (req, res) => {
  const user = await one('SELECT * FROM users WHERE id = $1', [req.userId]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user: publicUser(user) });
});

router.post('/logout', requireAuth, async (req, res) => {
  await query('UPDATE users SET is_online = false WHERE id = $1', [req.userId]);
  res.json({ ok: true });
});

module.exports = { router, publicUser };
