const express = require('express');
const { one } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { callClaude } = require('../lib/ai');

const router = express.Router();

function parseList(field) {
  try { return field ? JSON.parse(field) : []; } catch (e) { return []; }
}

function jaccard(a = [], b = []) {
  const A = new Set(a.map((s) => s.toLowerCase()));
  const B = new Set(b.map((s) => s.toLowerCase()));
  if (!A.size || !B.size) return 0;
  const inter = [...A].filter((x) => B.has(x)).length;
  const union = new Set([...A, ...B]).size;
  return union ? inter / union : 0;
}

async function loadMatchPair(matchId, userId) {
  const match = await one('SELECT * FROM matches WHERE id = $1', [matchId]);
  if (!match || (match.user_a !== userId && match.user_b !== userId)) return null;
  const otherId = match.user_a === userId ? match.user_b : match.user_a;
  const me = await one('SELECT * FROM users WHERE id = $1', [userId]);
  const other = await one('SELECT * FROM users WHERE id = $1', [otherId]);
  return { match, me, other };
}

// ---------- AI bio generator ----------
// body: { keywords: "hiking, coffee, product design", tone?: 'witty'|'sincere'|'chill' }
router.post('/bio', requireAuth, async (req, res) => {
  const keywords = (req.body.keywords || '').trim();
  const tone = ['witty', 'sincere', 'chill'].includes(req.body.tone) ? req.body.tone : 'witty';
  if (!keywords) return res.status(400).json({ error: 'keywords is required' });

  const prompt = `Write one dating-app bio, ${tone} tone, under 200 characters, first person, no hashtags, no quotation marks around it. Base it on these facts about the person: ${keywords}. Return only the bio text and nothing else.`;
  const ai = await callClaude(prompt, { maxTokens: 150 });
  if (ai) return res.json({ bio: ai.replace(/^"|"$/g, ''), source: 'ai' });

  const bits = keywords.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 3);
  const bio = bits.length
    ? `${bits.join(' • ')}. Probably talking about one of these right now — say hi and find out.`
    : `New here, still figuring out my bio. Ask me something interesting and I'll tell you the rest.`;
  res.json({ bio, source: 'template' });
});

// ---------- AI icebreakers for a match ----------
// body: { matchId }
router.post('/icebreakers', requireAuth, async (req, res) => {
  const { matchId } = req.body;
  if (!matchId) return res.status(400).json({ error: 'matchId is required' });
  const pair = await loadMatchPair(matchId, req.userId);
  if (!pair) return res.status(404).json({ error: 'Match not found' });
  const { me, other } = pair;

  const myInterests = parseList(me.interests);
  const otherInterests = parseList(other.interests);
  const shared = myInterests.filter((i) => otherInterests.map((x) => x.toLowerCase()).includes(i.toLowerCase()));

  const prompt = `Generate 3 short, casual, non-cheesy opening chat messages (each under 15 words) for a dating app. Person A's interests: ${myInterests.join(', ') || 'unknown'}. Person B is named ${other.name}, bio: "${other.bio || 'none'}", interests: ${otherInterests.join(', ') || 'unknown'}. Shared interests: ${shared.join(', ') || 'none obvious'}. Respond with ONLY a JSON array of exactly 3 strings, nothing else.`;
  const ai = await callClaude(prompt, { maxTokens: 200 });
  if (ai) {
    try {
      const match = ai.match(/\[[\s\S]*\]/);
      const parsed = match ? JSON.parse(match[0]) : null;
      if (Array.isArray(parsed) && parsed.length) {
        return res.json({ icebreakers: parsed.slice(0, 3), source: 'ai' });
      }
    } catch (e) { /* fall through to template */ }
  }

  const firstName = (other.name || '').split(' ')[0] || 'there';
  const templates = shared.length
    ? [
        `Okay I saw ${shared[0]} on your profile — how'd you get into that?`,
        `${shared[0]} fan too? What got you started?`,
        `We both like ${shared[0]}, so I have to ask — favorite so far?`,
      ]
    : [
        `Hey ${firstName}, what's been the best part of your week?`,
        `Random question — what's a hobby you'd pick up if you had more free time?`,
        `Hi! Your profile caught my eye — what's your story?`,
      ];
  res.json({ icebreakers: templates, source: 'template' });
});

// ---------- Compatibility score ----------
// Basic score + one-line "why" for everyone. Premium (plus/pro/ultra) users
// additionally get a per-category breakdown and a richer AI-written explanation.
router.get('/compatibility/:matchId', requireAuth, async (req, res) => {
  const pair = await loadMatchPair(req.params.matchId, req.userId);
  if (!pair) return res.status(404).json({ error: 'Match not found' });
  const { me, other } = pair;

  const myInterests = parseList(me.interests);
  const otherInterests = parseList(other.interests);
  const interestScore = jaccard(myInterests, otherInterests);
  const ageDiff = Math.abs((me.age || 0) - (other.age || 0));
  const ageScore = Math.max(0, 1 - ageDiff / 20);
  const score = Math.max(15, Math.round((interestScore * 0.7 + ageScore * 0.3) * 100));
  const shared = myInterests.filter((i) => otherInterests.map((x) => x.toLowerCase()).includes(i.toLowerCase()));

  let why = shared.length
    ? `You both like ${shared.slice(0, 2).join(' and ')}.`
    : `You're both open to meeting someone new — sometimes that's the best start.`;

  const isPremium = !!me.premium;
  let breakdown = null;
  if (isPremium) {
    breakdown = {
      interests: Math.round(interestScore * 100),
      ageFit: Math.round(ageScore * 100),
    };
    const prompt = `Two dating app users just matched. Person A interests: ${myInterests.join(', ') || 'none listed'}, bio: "${me.bio || 'none'}". Person B interests: ${otherInterests.join(', ') || 'none listed'}, bio: "${other.bio || 'none'}". In 2 short warm sentences, explain specifically why they might get along. Return only the explanation text.`;
    const ai = await callClaude(prompt, { maxTokens: 150 });
    if (ai) why = ai;
  }

  res.json({ score, why, breakdown, premium: isPremium });
});

// ---------- Translate a message ----------
// Plus/Pro/Ultra feature — matches the "AI translation" perk on paid tiers.
router.post('/translate', requireAuth, async (req, res) => {
  const me = await one('SELECT * FROM users WHERE id = $1', [req.userId]);
  if (!me.premium) {
    return res.status(402).json({ error: 'Message translation is a Plus/Pro/Ultra feature. Upgrade to translate messages.' });
  }
  const { text, targetLang } = req.body;
  if (!text || !targetLang) return res.status(400).json({ error: 'text and targetLang are required' });

  const prompt = `Translate the following message into ${targetLang}. Return only the translated text, nothing else, no quotation marks.\n\nMessage: ${text}`;
  const ai = await callClaude(prompt, { maxTokens: 200 });
  if (ai) return res.json({ translated: ai, source: 'ai' });
  res.json({ translated: text, source: 'unavailable', note: 'AI translation is not configured yet (missing ANTHROPIC_API_KEY on the server) — showing the original text.' });
});

module.exports = router;
