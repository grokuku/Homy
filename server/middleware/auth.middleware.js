import { verifyToken } from '../services/auth.service.js';

/**
 * JWT guard. Protects /api/* except the public routes listed in `publicPaths`.
 * Reads the token from the `Authorization: Bearer <token>` header.
 */
export function authGuard(publicPaths = []) {
  return async (c, next) => {
    const { pathname } = new URL(c.req.url);
    if (publicPaths.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
      return next();
    }

    const header = c.req.header('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const payload = token ? verifyToken(token) : null;

    if (!payload) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    c.set('user', payload.sub);
    return next();
  };
}
