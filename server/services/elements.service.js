import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Store } from './store.service.js';

/**
 * Elements service: CRUD over the GLOBAL catalogue of reusable "elements".
 *
 * The catalogue lives in its OWN file `elements.json` (NOT in `layout.json`):
 * `layout.json` is rewritten in full on every drag, so coupling a stable
 * referential to volatile grid data would mean useless writes. Shape:
 *
 *   { version: 1, elements: [ { id, name, icon, url, description,
 *                               healthCheck, docky, createdAt, updatedAt } ] }
 *
 * Field contract (validated STRICTLY on write → 400, never silently coerced):
 *   - id           server UUID, IMMUTABLE (never accepted from the client);
 *   - name         trimmed, 1..60 chars, required;
 *   - icon         string ≤ 256 chars, empty allowed (emoji / `holaf:<name>` /
 *                  http(s) URL / future `local:<slug>`);
 *   - url          empty, or a valid http/https URL;
 *   - description  string ≤ 300 chars, optional (defaults to '');
 *   - healthCheck  boolean, default false;
 *   - docky        null or `{ agent: ≤64, container: ≤128 }`;
 *   - createdAt / updatedAt  ISO timestamps (server-generated).
 *
 * Bounds: MAX_ELEMENTS. The route caps the request body at 256 KB (413).
 *
 * LAZY, NON-DESTRUCTIVE load (mirrors layout.service.js): a missing OR corrupt
 * file yields an EMPTY catalogue (a corrupt file also logs an error). NOTHING
 * is ever written automatically — the original file is only overwritten by the
 * first voluntary mutation. Load coercion is tolerant (a stored entry with an
 * invalid/missing name is skipped) and never throws.
 */
export const ELEMENTS_VERSION = 1;
export const MAX_ELEMENTS = 200;
export const ELEMENT_NAME_MAX = 60;
export const ELEMENT_ICON_MAX = 256;
export const ELEMENT_URL_MAX = 2048;
export const ELEMENT_DESCRIPTION_MAX = 300;
export const DOCKY_AGENT_MAX = 64;
export const DOCKY_CONTAINER_MAX = 128;

/** Thrown by create()/update() on invalid input; the route maps it to HTTP 400. */
export class ElementsValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ElementsValidationError';
    this.status = 400;
  }
}

export class ElementsService {
  constructor(store) {
    this.store = store;
    this.elements = this._load(); // never throws: degrades to an empty catalogue
  }

  _file() {
    return path.join(this.store.dataDir, 'elements.json');
  }

  _load() {
    const data = this.store.read('elements', null);
    if (data === null) {
      // Missing file OR corrupt JSON (Store.read() cannot tell them apart).
      if (existsSync(this._file())) {
        console.error(
          '[elements] elements.json is corrupt — starting from an empty catalogue. ' +
            'The file is NOT rewritten automatically; it will be overwritten on the next voluntary change.'
        );
      }
      return [];
    }
    const raw = Array.isArray(data?.elements) ? data.elements : [];
    const out = [];
    for (const entry of raw) {
      const clean = coerceStored(entry);
      if (clean) out.push(clean);
      if (out.length >= MAX_ELEMENTS) break;
    }
    return out;
  }

  // ---- Reads ----------------------------------------------------------------

  list() {
    return this.elements;
  }

  count() {
    return this.elements.length;
  }

  get(id) {
    return this.elements.find((e) => e.id === id) ?? null;
  }

  // ---- Writes ---------------------------------------------------------------

  /** Create an element. Returns the stored element; throws on invalid input. */
  create(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new ElementsValidationError('Element must be an object');
    }
    const fields = validateFields(input, { partial: false });
    if (this.elements.length >= MAX_ELEMENTS) {
      throw new ElementsValidationError(`Too many elements (max ${MAX_ELEMENTS})`);
    }
    const now = new Date().toISOString();
    const element = { id: randomUUID(), ...fields, createdAt: now, updatedAt: now };
    this.elements.push(element);
    this._persist();
    return element;
  }

  /**
   * Partially update an element. Only the provided fields are touched
   * (id/createdAt stay immutable). Returns null when the id is unknown;
   * throws on invalid input.
   */
  update(id, patch) {
    const element = this.get(id);
    if (!element) return null;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new ElementsValidationError('Element must be an object');
    }
    const fields = validateFields(patch, { partial: true });
    Object.assign(element, fields);
    element.updatedAt = new Date().toISOString();
    this._persist();
    return element;
  }

  /** Delete an element by id. Returns true when something was removed. */
  remove(id) {
    const index = this.elements.findIndex((e) => e.id === id);
    if (index === -1) return false;
    this.elements.splice(index, 1);
    this._persist();
    return true;
  }

  _persist() {
    this.store.write('elements', { version: ELEMENTS_VERSION, elements: this.elements }, 500);
  }
}

// ---- Validation -------------------------------------------------------------

/**
 * Validate + normalize the writable fields. `partial` = true (PATCH): absent
 * fields are left untouched; false (POST): absent fields take their default.
 * Returns a plain object with ONLY the normalized fields present.
 */
function validateFields(input, { partial }) {
  const out = {};
  const has = (key) => input[key] !== undefined;

  // name — required on create, 1..60 after trim.
  if (has('name')) {
    if (typeof input.name !== 'string') throw new ElementsValidationError('name must be a string');
    const name = input.name.trim();
    if (!name || name.length > ELEMENT_NAME_MAX) {
      throw new ElementsValidationError(`name must be 1 to ${ELEMENT_NAME_MAX} characters after trim`);
    }
    out.name = name;
  } else if (!partial) {
    throw new ElementsValidationError('name is required');
  }

  // icon — string ≤ 256 (empty allowed).
  if (has('icon')) {
    if (input.icon === null) out.icon = '';
    else if (typeof input.icon !== 'string') throw new ElementsValidationError('icon must be a string');
    else {
      const icon = input.icon.trim();
      if (icon.length > ELEMENT_ICON_MAX) {
        throw new ElementsValidationError(`icon must be at most ${ELEMENT_ICON_MAX} characters`);
      }
      out.icon = icon;
    }
  } else if (!partial) out.icon = '';

  // url — empty or a valid http/https URL.
  if (has('url')) {
    if (input.url === null || input.url === '') out.url = '';
    else if (typeof input.url !== 'string') throw new ElementsValidationError('url must be a string');
    else {
      const url = input.url.trim();
      if (url.length > ELEMENT_URL_MAX) throw new ElementsValidationError(`url must be at most ${ELEMENT_URL_MAX} characters`);
      if (url && !isHttpUrl(url)) throw new ElementsValidationError('url must be a valid http(s) URL');
      out.url = url;
    }
  } else if (!partial) out.url = '';

  // description — string ≤ 300 (empty allowed).
  if (has('description')) {
    if (input.description === null) out.description = '';
    else if (typeof input.description !== 'string') throw new ElementsValidationError('description must be a string');
    else {
      const description = input.description.trim();
      if (description.length > ELEMENT_DESCRIPTION_MAX) {
        throw new ElementsValidationError(`description must be at most ${ELEMENT_DESCRIPTION_MAX} characters`);
      }
      out.description = description;
    }
  } else if (!partial) out.description = '';

  // healthCheck — boolean, default false.
  if (has('healthCheck')) {
    if (typeof input.healthCheck !== 'boolean') throw new ElementsValidationError('healthCheck must be a boolean');
    out.healthCheck = input.healthCheck;
  } else if (!partial) out.healthCheck = false;

  // docky — null or { agent: ≤64, container: ≤128 }.
  if (has('docky')) {
    out.docky = validateDocky(input.docky);
  } else if (!partial) out.docky = null;

  return out;
}

function validateDocky(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ElementsValidationError('docky must be an object with { agent, container } or null');
  }
  const agent = validateDockyPart(raw.agent, DOCKY_AGENT_MAX, 'docky.agent');
  const container = validateDockyPart(raw.container, DOCKY_CONTAINER_MAX, 'docky.container');
  if (!agent && !container) return null;
  return { agent, container };
}

function validateDockyPart(value, max, field) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new ElementsValidationError(`${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new ElementsValidationError(`${field} must be at most ${max} characters`);
  return trimmed;
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

// ---- Tolerant load coercion (never throws) ----------------------------------

/** Coerce a stored entry; returns null when it holds no usable identity. */
function coerceStored(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, ELEMENT_NAME_MAX) : '';
  if (!name) return null;
  const now = new Date().toISOString();
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : randomUUID(),
    name,
    icon: typeof raw.icon === 'string' ? raw.icon.trim().slice(0, ELEMENT_ICON_MAX) : '',
    url: typeof raw.url === 'string' ? raw.url.trim().slice(0, ELEMENT_URL_MAX) : '',
    description: typeof raw.description === 'string' ? raw.description.trim().slice(0, ELEMENT_DESCRIPTION_MAX) : '',
    healthCheck: raw.healthCheck === true,
    docky: coerceDocky(raw.docky),
    createdAt: isIsoString(raw.createdAt) ? raw.createdAt : now,
    updatedAt: isIsoString(raw.updatedAt) ? raw.updatedAt : now,
  };
}

function coerceDocky(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const agent = typeof raw.agent === 'string' ? raw.agent.trim().slice(0, DOCKY_AGENT_MAX) : '';
  const container = typeof raw.container === 'string' ? raw.container.trim().slice(0, DOCKY_CONTAINER_MAX) : '';
  return agent || container ? { agent, container } : null;
}

function isIsoString(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}
