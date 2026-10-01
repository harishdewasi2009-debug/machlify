// Pure helpers for Random Chat message safety. No I/O, so they're trivially
// unit-testable and reused by the socket path and the REST path alike.

export type FilterResult = { ok: true } | { ok: false; reason: string };

const EMAIL_RE = /[a-z0-9._%+-]+\s*(?:@|\(at\)|\[at\])\s*[a-z0-9-]+\s*(?:\.|\(dot\)|\[dot\])\s*[a-z]{2,}/i;
const URL_RE = /(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|net|org|io|me|in|co|app|xyz|link|ly|gl)\b\/?\S*/i;
const HANDLE_RE = /\b(?:whats\s?app|telegram|snap(?:chat)?|insta(?:gram)?|signal)\b.{0,20}[@+\d]/i;
const SENSITIVE_RE = /\b(?:otp|cvv|password|passcode|pin\s?(?:code|number)|card\s?number|upi\s?(?:id|pin)|bank\s?account|aadhaar|ssn)\b/i;

// Strips separators so "98 76-54.32 10" is read as a phone number.
function digitRun(text: string): number {
  let longest = 0;
  let current = 0;
  for (const ch of text) {
    if (ch >= "0" && ch <= "9") {
      current++;
      longest = Math.max(longest, current);
    } else if (ch === " " || ch === "-" || ch === "." || ch === "(" || ch === ")" || ch === "+") {
      // separator inside a number: keep counting
    } else {
      current = 0;
    }
  }
  return longest;
}

export function checkMessageContent(raw: string): FilterResult {
  if (EMAIL_RE.test(raw)) return { ok: false, reason: "Don't share email addresses in Random Chat." };
  if (digitRun(raw) >= 8) return { ok: false, reason: "Don't share phone numbers or long numeric IDs in Random Chat." };
  if (URL_RE.test(raw)) return { ok: false, reason: "Links can't be sent in Random Chat." };
  if (HANDLE_RE.test(raw)) return { ok: false, reason: "Move to other apps only after you've matched on Matchify." };
  if (SENSITIVE_RE.test(raw)) return { ok: false, reason: "Never share passwords, OTPs or financial details." };
  return { ok: true };
}

export function normalizeForDuplicateCheck(raw: string): string {
  return raw.toLowerCase().replace(/\s+/g, " ").trim();
}

// Simple sliding-window limiter, per key, in-process. Multi-instance
// deployments should swap the Map for Redis INCR+EXPIRE; the interface is the
// same (see README section "Random Chat -> Scaling").
export class SlidingWindowLimiter {
  private hits = new Map<string, number[]>();
  constructor(private limit: number, private windowMs: number) {}

  /** Returns 0 when allowed, otherwise ms until the caller may retry. */
  take(key: string, now = Date.now()): number {
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.limit) {
      this.hits.set(key, arr);
      return this.windowMs - (now - arr[0]);
    }
    arr.push(now);
    this.hits.set(key, arr);
    return 0;
  }

  prune(now = Date.now()) {
    for (const [k, arr] of this.hits) {
      const fresh = arr.filter((t) => now - t < this.windowMs);
      if (fresh.length === 0) this.hits.delete(k);
      else this.hits.set(k, fresh);
    }
  }
}

export const COMMON_INTEREST_EMOJI: Record<string, string> = {
  music: "🎵", movies: "🎬", coffee: "☕", travel: "✈️", fitness: "💪", food: "🍜", books: "📚",
  gaming: "🎮", art: "🎨", photography: "📷", cooking: "🍳", hiking: "🥾", dancing: "💃", yoga: "🧘",
  cricket: "🏏", football: "⚽", tech: "💻", pets: "🐾", fashion: "👗", anime: "🌸",
};

export function interestEmoji(name: string): string {
  return COMMON_INTEREST_EMOJI[name.toLowerCase()] ?? "✨";
}
