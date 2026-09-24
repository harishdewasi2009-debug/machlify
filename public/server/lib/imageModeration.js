// Image moderation adapter. IMAGE_MODERATION_PROVIDER = none | sightengine.
//  - none: dev/test → auto-approve; production → every photo goes to the human review queue.
//  - sightengine: nudity / offensive / minors-adjacent checks (needs API user + secret).
// Return: { status: 'approved'|'needs_review'|'rejected', labels: {...} }

async function moderateImage(buffer, mime = 'image/jpeg') {
  const provider = (process.env.IMAGE_MODERATION_PROVIDER || 'none').toLowerCase();
  if (provider === 'sightengine') return sightengine(buffer, mime);
  if (process.env.NODE_ENV === 'production') return { status: 'needs_review', labels: { provider: 'none' } };
  return { status: 'approved', labels: { provider: 'none', note: 'auto-approved outside production' } };
}

async function sightengine(buffer, mime) {
  const user = process.env.SIGHTENGINE_USER, secret = process.env.SIGHTENGINE_SECRET;
  if (!user || !secret) return { status: 'needs_review', labels: { error: 'sightengine_not_configured' } };
  try {
    const form = new FormData();
    form.append('media', new Blob([buffer], { type: mime }), 'photo');
    form.append('models', 'nudity-2.1,offensive,gore-2.0');
    form.append('api_user', user); form.append('api_secret', secret);
    const res = await fetch('https://api.sightengine.com/1.0/check.json', { method: 'POST', body: form });
    if (!res.ok) return { status: 'needs_review', labels: { error: 'provider_http_' + res.status } };
    const j = await res.json();
    const n = j.nudity || {};
    const explicit = Math.max(n.sexual_activity || 0, n.sexual_display || 0, n.erotica || 0);
    const gore = j.gore?.prob || 0;
    const labels = { explicit, suggestive: n.suggestive || 0, gore, offensive: j.offensive?.prob || 0 };
    if (explicit > 0.6 || gore > 0.7) return { status: 'rejected', labels };
    if (explicit > 0.25 || (n.suggestive || 0) > 0.7 || gore > 0.3 || labels.offensive > 0.6) return { status: 'needs_review', labels };
    return { status: 'approved', labels };
  } catch (e) {
    return { status: 'needs_review', labels: { error: e.message } };
  }
}
module.exports = { moderateImage };
