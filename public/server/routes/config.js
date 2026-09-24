const express = require('express');
const crypto = require('crypto');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// ICE servers for WebRTC. STUN alone fails on many mobile/CGNAT networks, so TURN is
// strongly recommended in production. Supports coturn "use-auth-secret" short-lived credentials.
router.get('/rtc', requireAuth, (req, res) => {
  const iceServers = [{ urls: process.env.STUN_URL || 'stun:stun.l.google.com:19302' }];
  const urls = (process.env.TURN_URL || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (urls.length) {
    if (process.env.TURN_SECRET) {
      const expiry = Math.floor(Date.now() / 1000) + 3600;
      const username = `${expiry}:${req.userId}`;
      iceServers.push({ urls, username, credential: crypto.createHmac('sha1', process.env.TURN_SECRET).update(username).digest('base64') });
    } else if (process.env.TURN_USERNAME) {
      iceServers.push({ urls, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL });
    }
  }
  res.json({ iceServers, turnConfigured: urls.length > 0 });
});

module.exports = { router };
