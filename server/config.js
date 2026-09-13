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
  ICONS_API_BASE: process.env.ICONS_API_BASE || 'https://api.iconify.design',
  ICONS_TIMEOUT_MS: Number(process.env.ICONS_TIMEOUT_MS || 8000),
  REPORTS_TIMEOUT_MS: Number(process.env.REPORTS_TIMEOUT_MS || 8000),
  // Docky integration (lot 5). DOCKY_URL / DOCKY_KEY OVERRIDE the values stored
  // in docky.json (write-only config section, never returned with the key).
  DOCKY_URL: process.env.DOCKY_URL || '',
  DOCKY_KEY: process.env.DOCKY_KEY || '',
  DOCKY_TIMEOUT_MS: Number(process.env.DOCKY_TIMEOUT_MS || 8000),
  DOCKY_STATS_TIMEOUT_MS: Number(process.env.DOCKY_STATS_TIMEOUT_MS || 15000),
  DOCKY_ACTION_TIMEOUT_MS: Number(process.env.DOCKY_ACTION_TIMEOUT_MS || 20000),
  DOCKY_CACHE_MS: Number(process.env.DOCKY_CACHE_MS || 30000),
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
  // Icon library (lot 7): the ONLY external host the server will call for
  // icon search/install. Configurable so a mirror / test stub can be swapped in.
  iconsApiBase: env.ICONS_API_BASE,
  iconsTimeoutMs: env.ICONS_TIMEOUT_MS,
  // Outbound timeout (ms) for report service calls (lot 8). Bounded server-side.
  reportsTimeoutMs: env.REPORTS_TIMEOUT_MS,
  // Docky integration (lot 5): env overrides + bounded outbound timeouts.
  dockyUrl: env.DOCKY_URL,
  dockyKey: env.DOCKY_KEY,
  dockyTimeoutMs: env.DOCKY_TIMEOUT_MS,
  dockyStatsTimeoutMs: env.DOCKY_STATS_TIMEOUT_MS,
  dockyActionTimeoutMs: env.DOCKY_ACTION_TIMEOUT_MS,
  dockyCacheMs: env.DOCKY_CACHE_MS,
};

export const authConfig = config;

export function persistAuthConfig(next) {
  Object.assign(config, next);
  saveConfig(config);
}
