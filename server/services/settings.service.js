import { Store } from './store.service.js';

/**
 * Settings service: dashboard-level preferences (theme + background),
 * persisted to `settings.json` via the atomic Store (tmp+rename, .bak,
 * debounced). In-memory copy so reads reflect pending writes immediately.
 *
 * Shape (validated strictly — invalid input is rejected, never silently
 * coerced):
 *   {
 *     theme: 'dark' | 'light',
 *     background: {
 *       type: 'none' | 'image' | 'procedural',
 *       image?:      { name, blur: 0..20, dim: 0..80, fixed: bool },
 *       procedural?: { generator, speed: 0..3, density: 1..100,
 *                      opacity: 0..1, blur: 0..40, links: bool, colors?: [hex…] },
 *     },
 *   }
 */

export const THEMES = ['dark', 'light'];
export const BG_TYPES = ['none', 'image', 'procedural'];
export const GENERATORS = ['waves', 'particles', 'aurora'];

// Same contract as background file names produced by the upload route
// (UUID + whitelisted extension). Kept in sync with backgrounds.routes.js.
export const BG_NAME_RE = /^[a-f0-9-]{36}\.(png|jpe?g|webp|avif)$/;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
  }
}

export class SettingsService {
  /**
   * @param {Store} store
   * @param {(name: string) => boolean} backgroundExists predicate used to
   *        validate that a referenced background image is present on disk.
   */
  constructor(store, backgroundExists = () => true) {
    this.store = store;
    this.backgroundExists = backgroundExists;
    this.data = this._load();
  }

  _load() {
    const data = this.store.read('settings', null);
    return this._sanitize(data) || this._defaults();
  }

  _defaults() {
    return { theme: 'dark', background: { type: 'none' } };
  }

  get() {
    return this.data;
  }

  /**
   * Replace the settings after strict validation.
   * Returns the sanitized settings; throws ValidationError on invalid input.
   */
  update(body) {
    const clean = this._sanitize(body, { requireTheme: true });
    this.data = clean;
    this.store.write('settings', this.data, 500);
    return this.data;
  }

  // ---- validation ----------------------------------------------------------

  _sanitize(raw, { requireTheme = false } = {}) {
    if (raw === null || raw === undefined) return null;
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ValidationError('Settings must be an object');
    }

    // theme
    let theme;
    if (raw.theme === undefined) {
      if (requireTheme) throw new ValidationError("Field 'theme' is required (dark | light)");
      theme = this.data?.theme || 'dark';
    } else {
      if (!THEMES.includes(raw.theme)) {
        throw new ValidationError(`Invalid theme "${String(raw.theme)}" — expected one of: ${THEMES.join(', ')}`);
      }
      theme = raw.theme;
    }

    return { theme, background: this._sanitizeBackground(raw.background) };
  }

  _sanitizeBackground(raw) {
    if (raw === undefined || raw === null) return { type: 'none' };
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ValidationError('background must be an object');
    }
    const type = raw.type;
    if (!BG_TYPES.includes(type)) {
      throw new ValidationError(
        `Invalid background.type "${String(type)}" — expected one of: ${BG_TYPES.join(', ')}`
      );
    }
    if (type === 'none') return { type: 'none' };

    if (type === 'image') {
      const img = raw.image;
      if (!img || typeof img !== 'object' || Array.isArray(img)) {
        throw new ValidationError("background.type 'image' requires a background.image object");
      }
      if (typeof img.name !== 'string' || !BG_NAME_RE.test(img.name)) {
        throw new ValidationError('background.image.name must be an uploaded background file name');
      }
      if (!this.backgroundExists(img.name)) {
        throw new ValidationError(`Unknown background image "${img.name}"`);
      }
      return {
        type: 'image',
        image: {
          name: img.name,
          blur: intInRange(img.blur ?? 0, 0, 20, 'background.image.blur'),
          dim: intInRange(img.dim ?? 0, 0, 80, 'background.image.dim'),
          fixed: !!img.fixed,
        },
      };
    }

    // procedural
    const proc = raw.procedural;
    if (!proc || typeof proc !== 'object' || Array.isArray(proc)) {
      throw new ValidationError("background.type 'procedural' requires a background.procedural object");
    }
    const generator = proc.generator === undefined ? 'waves' : proc.generator;
    if (!GENERATORS.includes(generator)) {
      throw new ValidationError(
        `Invalid background.procedural.generator "${String(generator)}" — expected one of: ${GENERATORS.join(', ')}`
      );
    }
    let colors;
    if (proc.colors === undefined || proc.colors === null || proc.colors === '') {
      colors = [];
    } else {
      if (!Array.isArray(proc.colors)) throw new ValidationError('background.procedural.colors must be an array of hex colors');
      if (proc.colors.length > 8) throw new ValidationError('background.procedural.colors accepts at most 8 colors');
      for (const c of proc.colors) {
        if (typeof c !== 'string' || !HEX_RE.test(c)) {
          throw new ValidationError(`Invalid color "${String(c)}" — expected #rrggbb`);
        }
      }
      colors = proc.colors.map((c) => c.toLowerCase());
    }
    return {
      type: 'procedural',
      procedural: {
        generator,
        speed: numInRange(proc.speed ?? 1, 0, 3, 'background.procedural.speed'),
        density: intInRange(proc.density ?? 10, 1, 100, 'background.procedural.density'),
        opacity: numInRange(proc.opacity ?? 1, 0, 1, 'background.procedural.opacity'),
        // Flou global du rendu procédural (px CSS). Validé ici pour que le
        // contrat « aucune entrée non validée n'atteint le client » tienne.
        blur: numInRange(proc.blur ?? 0, 0, 40, 'background.procedural.blur'),
        links: proc.links === undefined ? true : !!proc.links,
        colors,
      },
    };
  }
}

function numInRange(v, min, max, field) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new ValidationError(`${field} must be a number`);
  if (n < min || n > max) throw new ValidationError(`${field} must be between ${min} and ${max}`);
  return Math.round(n * 1000) / 1000;
}

function intInRange(v, min, max, field) {
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw new ValidationError(`${field} must be an integer`);
  if (n < min || n > max) throw new ValidationError(`${field} must be between ${min} and ${max}`);
  return n;
}