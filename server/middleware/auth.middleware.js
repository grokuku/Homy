import { refreshedToken, verifyToken } from '../services/auth.service.js';

/**
 * JWT guard. Protects /api/* except the public routes listed in `publicPaths`.
 * Reads the token from the `Authorization: Bearer <token>` header.
 *
 * Sliding session: when the presented token is past its refresh threshold
 * (see REFRESH_RATIO), a fresh token is returned in the `X-Refreshed-Token`
 * response header so the client can replace it. This travels only on
 * already-authenticated responses, is never logged, and carries the user's own
 * credential — the same value `POST /api/auth/login` returns.
 */
export function authGuard(publicPaths = []) {
  return async (c, next) => {
    const { pathname } = new URL(c.req.url);
    if (
      publicPaths.some((p) =>
        p instanceof RegExp ? p.test(pathname) : pathname === p || pathname.startsWith(`${p}/`)
      )
    ) {
      return next();
    }

    const header = c.req.header('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const payload = token ? verifyToken(token) : null;

    if (!payload) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    c.set('user', payload.sub);
    const rotated = refreshedToken(payload);
    await next();
    if (rotated) c.header('X-Refreshed-Token', rotated);
  };
}
