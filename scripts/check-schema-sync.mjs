#!/usr/bin/env node
/**
 * settingsSchema sync check — server manifest (routes/widgets.routes.js) vs
 * frontend registry (public/js/widgets/registry.js).
 *
 * The schemas are intentionally duplicated (no build step); this script fails
 * with a diff if the two sides drift apart. Run: node scripts/check-schema-sync.mjs
 */
import { widgetRoutes } from '../server/routes/widgets.routes.js';

// Browser globals stub — the frontend modules touch localStorage/DOM at import
// time; we only need their data (registry schemas), not their behavior.
globalThis.localStorage = {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); },
};
globalThis.window = { dispatchEvent() {}, addEventListener() {} };

const { registry, getSettingsSchema } = await import('../public/js/widgets/registry.js');

// Fields compared (any other prop would be compared too — keep strict).
function normField(f) {
  if (!f || typeof f !== 'object') return f;
  const out = {};
  for (const k of ['key', 'label', 'type', 'default', 'options', 'placeholder', 'required', 'min', 'max', 'step', 'unit', 'help', 'rows', 'itemLabel']) {
    if (f[k] !== undefined) out[k] = f[k];
  }
  if (Array.isArray(f.fields)) out.fields = f.fields.map(normField);
  return out;
}
function normSchema(s) {
  return (s?.fields || []).map(normField);
}

const res = await widgetRoutes.request('/');
if (!res.ok) {
  console.error(`server manifest request failed: ${res.status}`);
  process.exit(1);
}
const { widgets } = await res.json();

let failures = 0;
const frontTypes = Object.keys(registry);

for (const w of widgets) {
  const front = getSettingsSchema(w.type);
  const server = w.settingsSchema;
  const a = JSON.stringify(normSchema(front));
  const b = JSON.stringify(normSchema(server));
  if (a !== b) {
    failures++;
    console.error(`✗ ${w.type}: settingsSchema MISMATCH\n  front : ${a}\n  server: ${b}`);
  } else {
    console.log(`✓ ${w.type}: settingsSchema in sync (${(front.fields || []).length} fields)`);
  }
}

for (const t of frontTypes) {
  if (!widgets.some((w) => w.type === t)) {
    failures++;
    console.error(`✗ widget type "${t}" exists in frontend registry but not in server manifest`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} mismatch(es) — server/front settingsSchema must stay in sync.`);
  process.exit(1);
}
console.log('\nAll widget settingsSchemas are in sync (server ↔ front).');