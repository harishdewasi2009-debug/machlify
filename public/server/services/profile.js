const { one, many, query } = require('../db');
const { parseJson } = require('../lib/util');

function computeStrength(user, approvedPhotos, promptCount) {
  let s = 0;
  s += approvedPhotos >= 4 ? 35 : approvedPhotos >= 2 ? 25 : approvedPhotos === 1 ? 10 : 0;
  const bio = (user.bio || '').trim().length;
  s += bio >= 40 ? 20 : bio >= 10 ? 8 : 0;
  const ints = (user.interest_tags || []).length;
  s += ints >= 3 ? 15 : ints >= 1 ? 5 : 0;
  s += promptCount >= 2 ? 15 : promptCount === 1 ? 10 : 0;
  if ((user.job || '').trim()) s += 5;
  if ((user.location || '').trim()) s += 5;
  if (user.relationship_intent) s += 5;
  return Math.min(100, s);
}

// Refresh the denormalised photo list (approved only, in order) + profile strength.
async function refreshProfile(userId) {
  const photos = await many(`SELECT url FROM photos WHERE user_id=$1 AND status='approved' ORDER BY position, id`, [userId]);
  const promptCount = Number((await one('SELECT COUNT(*) c FROM profile_prompts WHERE user_id=$1', [userId])).c);
  const user = await one('SELECT * FROM users WHERE id=$1', [userId]);
  if (!user) return null;
  const strength = computeStrength(user, photos.length, promptCount);
  await query('UPDATE users SET photos=$2, profile_strength=$3 WHERE id=$1', [userId, JSON.stringify(photos.map((p) => p.url)), strength]);
  return strength;
}

async function loadPrompts(userId) {
  const rows = await many('SELECT prompt_key, answer FROM profile_prompts WHERE user_id=$1 ORDER BY position, id', [userId]);
  return rows.map((r) => ({ key: r.prompt_key, answer: r.answer }));
}
async function loadPhotoItems(userId) {
  const rows = await many(`SELECT id, url, thumb_url, status, position FROM photos WHERE user_id=$1 ORDER BY position, id`, [userId]);
  return rows.map((r) => ({ id: r.id, url: r.url, thumb: r.thumb_url || r.url, status: r.status, position: r.position }));
}
async function loadSelfExtras(userId) {
  const [prompts, photoItems] = await Promise.all([loadPrompts(userId), loadPhotoItems(userId)]);
  return { prompts, photoItems };
}

module.exports = { computeStrength, refreshProfile, loadPrompts, loadPhotoItems, loadSelfExtras, parseJson };
