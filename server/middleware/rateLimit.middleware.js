/**
 * Simple in-memory rate limiter (per IP). Used for the login endpoint.
 * Sliding window: `max` attempts per `windowMs` per IP.
 */
export function rateLimit({ windowMs = 15 * 60 * 1000, max = 5 } = {}) {
  const hits = new Map(); // ip -> { count, resetAt }

  // periodic cleanup to avoid unbounded growth
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(ip);
    }
  }, windowMs);
  cleanup.unref?.();

  return async (c, next) => {
    const ip = c.req.header('x-forwarded-for')?.split(',')[0].trim() || c.env?.remote?.address || 'unknown';
    const now = Date.now();
    let entry = hits.get(ip);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(ip, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      c.header('Retry-After', String(retryAfter));
      return c.json({ error: 'Too many attempts, try again later' }, 429);
    }
    return next();
  };
}
