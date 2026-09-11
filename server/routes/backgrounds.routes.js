import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';

/**
 * Background image management.
 *
 * - POST   /api/backgrounds        multipart upload (field name: "file")
 * - GET    /api/backgrounds        list uploaded backgrounds
 * - DELETE /api/backgrounds/:name  delete one (409 if currently in use)
 *
 * Storage: DATA_DIR/backgrounds/<uuid>.<ext> — names are random UUIDs, never
 * user-controlled strings, which is what makes the public static serving of
 * /backgrounds/* (see index.js) acceptable (see README Security notes).
 *
 * Upload hardening:
 *   - extension whitelist: png / jpg / jpeg / webp / avif
 *   - magic bytes check (PNG \x89PNG, JPEG \xFF\xD8\xFF, WEBP RIFF…WEBP,
 *     AVIF ftyp avif/avis) — content must match the declared extension
 *   - 10 MiB max per file, rejected BEFORE any disk write (Content-Length
 *     header guard + post-parse size guard)
 *   - max 20 files stored (409 beyond that)
 */

const MAX_SIZE = 10 * 1024 * 1024; // 10 MiB
const MAX_FILES = 20;

const EXT_WHITELIST = new Set(['png', 'jpg', 'jpeg', 'webp', 'avif']);
const MIME_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
};

// Same contract as SettingsService (background.image.name validation).
export const BG_NAME_RE = /^[a-f0-9-]{36}\.(png|jpe?g|webp|avif)$/;

/** Verify magic bytes match the (whitelisted) extension. */
export function magicBytesOk(buf, ext) {
  if (!buf || buf.length < 12) return false;
  switch (ext) {
    case 'png':
      // \x89PNG\r\n\x1a\n
      return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
        buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a;
    case 'jpg':
    case 'jpeg':
      return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    case 'webp':
      return buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
    case 'avif': {
      // ISO-BMFF: bytes 4..8 = "ftyp", major brand at 8..12: avif (or avis).
      if (buf.toString('ascii', 4, 8) !== 'ftyp') return false;
      const brand = buf.toString('ascii', 8, 12);
      return brand === 'avif' || brand === 'avis';
    }
    default:
      return false;
  }
}

export function backgroundRoutes(settingsService, dataDir) {
  const dir = path.join(dataDir, 'backgrounds');
  mkdirSync(dir, { recursive: true });

  const routes = new Hono();

  routes.post('/', async (c) => {
    // Reject oversized uploads before reading/parsing anything.
    const contentLength = Number(c.req.header('content-length') || 0);
    if (contentLength > MAX_SIZE + 64 * 1024) {
      return c.json({ error: 'Background image too large (max 10 MB)' }, 413);
    }

    let form;
    try {
      form = await c.req.parseBody();
    } catch {
      return c.json({ error: 'Invalid multipart body' }, 400);
    }
    const file = form?.file;
    if (!file || typeof file === 'string' || typeof file.arrayBuffer !== 'function') {
      return c.json({ error: "Missing file field 'file'" }, 400);
    }
    if (file.size > MAX_SIZE) {
      return c.json({ error: 'Background image too large (max 10 MB)' }, 413);
    }
    if (file.size === 0) {
      return c.json({ error: 'Empty file' }, 400);
    }

    // Quota: max 20 stored backgrounds.
    const existing = listFiles(dir);
    if (existing.length >= MAX_FILES) {
      return c.json({ error: `Too many backgrounds (max ${MAX_FILES})` }, 409);
    }

    // Extension whitelist (from the original filename).
    const original = String(file.name || 'upload');
    const ext = path.extname(original).slice(1).toLowerCase();
    if (!EXT_WHITELIST.has(ext)) {
      return c.json({ error: `Unsupported extension ".${ext}" — allowed: ${[...EXT_WHITELIST].join(', ')}` }, 400);
    }

    // Content must match the declared extension (magic bytes).
    const buf = Buffer.from(await file.arrayBuffer());
    if (buf.length > MAX_SIZE) {
      return c.json({ error: 'Background image too large (max 10 MB)' }, 413);
    }
    if (!magicBytesOk(buf, ext)) {
      return c.json({ error: 'File content does not look like a valid image' }, 400);
    }

    // Unpredictable name (UUID) — this is what allows public static serving.
    const name = `${randomUUID()}.${ext}`;
    const target = path.join(dir, name);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, buf);
    renameSync(tmp, target);

    return c.json({ name, size: buf.length, url: `/backgrounds/${name}` }, 201);
  });

  routes.get('/', (c) => {
    const files = listFiles(dir).map((f) => {
      const st = statSync(path.join(dir, f));
      return {
        name: f,
        size: st.size,
        url: `/backgrounds/${f}`,
        uploadedAt: st.mtime.toISOString(),
      };
    });
    return c.json({ files });
  });

  routes.delete('/:name', (c) => {
    const name = c.req.param('name');
    // Strict format check — doubles as path-traversal protection (no dots,
    // slashes or anything outside the UUID+ext pattern can match).
    if (typeof name !== 'string' || !BG_NAME_RE.test(name)) {
      return c.json({ error: 'Invalid background name' }, 400);
    }
    // Explicit choice: refuse to delete a background currently referenced by
    // the dashboard settings (no cascade delete).
    const current = settingsService.get();
    if (current?.background?.type === 'image' && current.background.image?.name === name) {
      return c.json({ error: 'Background is currently in use — remove it from the dashboard settings first' }, 409);
    }
    const target = path.join(dir, path.basename(name));
    if (!existsSync(target)) {
      return c.json({ error: 'Not found' }, 404);
    }
    try {
      unlinkSync(target);
    } catch (err) {
      return c.json({ error: `Failed to delete: ${err.message}` }, 500);
    }
    return c.json({ ok: true });
  });

  return routes;
}

function listFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => BG_NAME_RE.test(f)).sort();
}

/**
 * Public static serving helper for /backgrounds/:name (no JWT — images are
 * referenced by <img>/CSS which cannot attach tokens). The name is strictly
 * validated against the UUID pattern, and the Content-Type is derived from
 * the extension whitelist only.
 */
export function serveBackgroundFile(dataDir) {
  const dir = path.join(dataDir, 'backgrounds');
  return (c) => {
    const name = c.req.param('name');
    if (typeof name !== 'string' || !BG_NAME_RE.test(name)) {
      return c.json({ error: 'Not found' }, 404);
    }
    const file = path.join(dir, path.basename(name));
    if (!existsSync(file)) {
      return c.json({ error: 'Not found' }, 404);
    }
    const ext = name.split('.').pop();
    const mime = MIME_BY_EXT[ext] || 'application/octet-stream';
    const body = readFileSync(file);
    return c.body(body, 200, {
      'Content-Type': mime,
      'Content-Length': String(body.length),
      // UUID names are immutable content — safe to cache aggressively.
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
  };
}