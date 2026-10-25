// A small "fixed window" request counter kept in memory.
//
// BEST EFFORT ONLY. On Vercel, each server instance has its own memory, and instances start
// and stop at any time, so this slows down casual abuse but cannot stop a determined person.
// Your Gemini/Groq spending limits are the real safety net (see README).

export function createRateLimiter({ max, windowMs, now = Date.now, maxKeys = 5000 }) {
  /** @type {Map<string, {count: number, resetAt: number}>} */
  const hits = new Map();

  function prune(t) {
    for (const [key, entry] of hits) if (entry.resetAt <= t) hits.delete(key);
    // If still too big (many different clients at once), drop the oldest entries.
    while (hits.size > maxKeys) hits.delete(hits.keys().next().value);
  }

  return {
    /** Counts one request for `key`. Returns { allowed, remaining, retryAfterSec }. */
    take(key) {
      const t = now();
      if (hits.size >= maxKeys) prune(t);
      let entry = hits.get(key);
      if (!entry || entry.resetAt <= t) {
        entry = { count: 0, resetAt: t + windowMs };
        hits.set(key, entry);
      }
      entry.count += 1;
      const allowed = entry.count <= max;
      return {
        allowed,
        remaining: Math.max(0, max - entry.count),
        retryAfterSec: allowed ? 0 : Math.max(1, Math.ceil((entry.resetAt - t) / 1000)),
      };
    },
    size: () => hits.size,
  };
}
