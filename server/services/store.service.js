import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Atomic JSON file store with debounced writes and .bak backups.
 *
 * - Writes go to a `<file>.tmp` then `renameSync` over the target (atomic on POSIX).
 * - The previous version is copied to `<file>.bak` before the new one is written.
 * - `write()` is debounced: rapid successive calls coalesce into one disk write.
 * - `writeNow()` flushes immediately (used on shutdown / critical paths).
 */
export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this._timers = new Map();
    this._pending = new Map();
    mkdirSync(dataDir, { recursive: true });
  }

  _file(name) {
    return path.join(this.dataDir, `${name}.json`);
  }

  /** Read a JSON file. Returns `fallback` (default `null`) if missing/corrupt. */
  read(name, fallback = null) {
    const file = this._file(name);
    if (!existsSync(file)) return fallback;
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return fallback;
    }
  }

  /** Debounced write. Returns a promise resolving when the write is flushed. */
  write(name, data, debounceMs = 500) {
    return new Promise((resolve) => {
      this._pending.set(name, { data, resolve });
      const existing = this._timers.get(name);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        this._timers.delete(name);
        this._flush(name);
      }, debounceMs);
      this._timers.set(name, timer);
    });
  }

  /** Flush immediately, bypassing the debounce. */
  writeNow(name, data) {
    const existing = this._timers.get(name);
    if (existing) {
      clearTimeout(existing);
      this._timers.delete(name);
    }
    this._pending.set(name, { data, resolve: () => {} });
    this._flush(name);
  }

  _flush(name) {
    const entry = this._pending.get(name);
    if (!entry) return;
    this._pending.delete(name);
    try {
      this._atomicWrite(name, entry.data);
      entry.resolve();
    } catch (err) {
      console.error(`[store] failed to write ${name}:`, err);
      entry.resolve();
    }
  }

  _atomicWrite(name, data) {
    const file = this._file(name);
    // backup previous version
    if (existsSync(file)) {
      try {
        writeFileSync(`${file}.bak`, readFileSync(file));
      } catch {
        /* ignore */
      }
    }
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    renameSync(tmp, file);
  }

  /** Flush all pending writes (call on shutdown). */
  flushAll() {
    for (const name of [...this._pending.keys()]) {
      this._flush(name);
    }
  }
}
