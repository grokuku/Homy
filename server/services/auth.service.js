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

export function signToken() {
  return jwt.sign({ sub: authConfig.user }, serverConfig.jwtSecret, {
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
