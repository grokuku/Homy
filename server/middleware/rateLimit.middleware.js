import { getConnInfo } from '@hono/node-server/conninfo';

/**
 * Simple in-memory rate limiter (per IP). Used for the login endpoint.
 * Sliding window: `max` attempts per `windowMs` per IP.
 *
 * IP resolution: we trust `x-forwarded-for` ONLY when TRUST_PROXY=true (i.e.
 * behind a trusted reverse proxy). By default (TRUST_PROXY unset/false) the
 * caller-supplied header is ignored entirely — this prevents an attacker from
 * spoofing the XFF header to bypass the limit.
 */

// Trust the `x-forwarded-for` header only behind a reverse proxy you control.
const TRUST_PROXY = [true, 1, '1', 'true', 'TRUE'].includes(process.env.TRUST_PROXY);

/** Resolve the real client IP for rate limiting. */
function clientIp(c) {
  const xff = c.req.header('x-forwarded-for');
  if (TRUST_PROXY && xff) {
    const first = xff.split(',')[0].trim();
    if (first) return first;
  }
  return getConnInfo(c)?.remote?.address || 'unknown';
}

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
    const ip = clientIp(c);
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
