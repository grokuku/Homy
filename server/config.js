import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- Environment -----------------------------------------------------------

const env = {
  PORT: Number(process.env.PORT || 3000),
  DATA_DIR: process.env.DATA_DIR || path.join(__dirname, 'data'),
  JWT_SECRET: process.env.JWT_SECRET || '',
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '7d',
  BCRYPT_ROUNDS: Number(process.env.BCRYPT_ROUNDS || 12),
};

// ---- config.json persistence ----------------------------------------------

const configPath = () => path.join(env.DATA_DIR, 'config.json');

function ensureDataDir() {
  mkdirSync(env.DATA_DIR, { recursive: true });
}

function loadConfig() {
  ensureDataDir();
  const file = configPath();
  if (!existsSync(file)) {
    return { user: null, passwordHash: null, jwtSecret: null, jwtExpiresIn: env.JWT_EXPIRES_IN };
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { user: null, passwordHash: null, jwtSecret: null, jwtExpiresIn: env.JWT_EXPIRES_IN };
  }
}

function saveConfig(config) {
  ensureDataDir();
  const file = configPath();
  // keep a backup of the previous version (if any)
  if (existsSync(file)) {
    try {
      writeFileSync(`${file}.bak`, readFileSync(file));
    } catch {
      /* ignore */
    }
  }
  // atomic write: temp file + rename
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8');
  renameSync(tmp, file);
}

// ---- Runtime config object -------------------------------------------------

const config = loadConfig();

// Auto-generate a JWT secret on first run and persist it.
if (!config.jwtSecret) {
  config.jwtSecret = env.JWT_SECRET || randomBytes(48).toString('hex');
  saveConfig(config);
}

export const serverConfig = {
  port: env.PORT,
  dataDir: env.DATA_DIR,
  jwtSecret: config.jwtSecret,
  jwtExpiresIn: config.jwtExpiresIn || env.JWT_EXPIRES_IN,
  bcryptRounds: env.BCRYPT_ROUNDS,
};

export const authConfig = config;

export function persistAuthConfig(next) {
  Object.assign(config, next);
  saveConfig(config);
}
