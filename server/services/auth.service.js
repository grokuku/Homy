import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { authConfig, persistAuthConfig, serverConfig } from '../config.js';

/**
 * Auth service: first-run setup, login/logout, credential management.
 * Passwords are bcrypt-hashed; sessions are stateless JWTs.
 */

export function isFirstRun() {
  return !authConfig.user || !authConfig.passwordHash;
}

export async function setup(user, password) {
  if (!isFirstRun()) {
    const err = new Error('Already configured');
    err.status = 409;
    throw err;
  }
  const passwordHash = await bcrypt.hash(password, serverConfig.bcryptRounds);
  persistAuthConfig({ user, passwordHash });
  return { user };
}

export async function verifyCredentials(user, password) {
  if (!authConfig.user || !authConfig.passwordHash) return false;
  if (user !== authConfig.user) return false;
  return bcrypt.compare(password, authConfig.passwordHash);
}

export function signToken(sub = authConfig.user) {
  return jwt.sign({ sub }, serverConfig.jwtSecret, {
    expiresIn: serverConfig.jwtExpiresIn,
  });
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, serverConfig.jwtSecret);
  } catch {
    return null;
  }
}

// Sliding session: re-issue the token once its REMAINING lifetime drops below
// this fraction of its total lifetime. Only token rotation tied to real use
// keeps an active user logged in while an abandoned token still expires on
// schedule (we never extend a token that is not being used).
export const REFRESH_RATIO = 0.5;

/**
 * Return a freshly signed token when the presented payload is past the refresh
 * threshold, otherwise null. Pure: no side effects, no logging. `nowMs` is
 * injectable for tests.
 */
export function refreshedToken(payload, nowMs = Date.now()) {
  if (!payload || typeof payload.exp !== 'number' || typeof payload.iat !== 'number') return null;
  const ttlMs = (payload.exp - payload.iat) * 1000;
  const remainingMs = payload.exp * 1000 - nowMs;
  if (ttlMs <= 0 || remainingMs <= 0) return null;
  if (remainingMs >= ttlMs * REFRESH_RATIO) return null;
  return signToken(payload.sub ?? authConfig.user);
}

export async function changeCredentials(currentPassword, nextUser, nextPassword) {
  const ok = await verifyCredentials(authConfig.user, currentPassword);
  if (!ok) {
    const err = new Error('Current password is incorrect');
    err.status = 401;
    throw err;
  }
  const passwordHash = await bcrypt.hash(nextPassword, serverConfig.bcryptRounds);
  persistAuthConfig({ user: nextUser, passwordHash });
  return { user: nextUser };
}
