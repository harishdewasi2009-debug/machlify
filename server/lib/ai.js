// Lightweight AI helper for Matchify's AI features (bio generator, icebreakers,
// compatibility explanations, translation).
//
// Uses the Anthropic API when ANTHROPIC_API_KEY is set in the environment.
// If no key is configured, callClaude() resolves to null and every route
// that calls it falls back to a fast deterministic template — so all AI
// features work out of the box in dev/demo, and light up with real AI the
// moment you add a key on Render.
//
// Node 18+ has a global fetch, so no extra dependency is needed.

const HAS_KEY = !!process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

async function callClaude(prompt, { maxTokens = 300 } = {}) {
  if (!HAS_KEY) return null;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) {
      console.error('Anthropic API error:', res.status, await res.text().catch(() => ''));
      return null;
    }
    const data = await res.json();
    const block = (data.content || []).find((b) => b.type === 'text');
    return block ? block.text.trim() : null;
  } catch (err) {
    console.error('Anthropic API call failed:', err.message);
    return null;
  }
}

module.exports = { callClaude, HAS_KEY };
