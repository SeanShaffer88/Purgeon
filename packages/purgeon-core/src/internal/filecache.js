// A small persistent per-file cache: remembers a computed value for a file while the
// file itself is unchanged (same modified time and size). Callers use it to avoid
// re-running expensive per-file work (signature checks, processor-architecture
// reads, icon extraction) on every program-list load: a value is only recomputed
// when its file's stamp no longer matches. Values must be JSON-serializable.
import { sys } from './sys.js';

const MAX_KEYS = 4000;

// The stamp a cached value is keyed to: the file's modified time and size.
export const stampOf = (stat) => `${stat?.modified || 0}:${stat?.size || 0}`;

export class FileCache {
  constructor(file) {
    this.file = file;
    this.map = {};
    this.dirty = false;
    this.count = 0;
    this.revision = 0;
  }

  // Loads the stored map; a missing or corrupt cache file just means an empty cache.
  async init() {
    try {
      const parsed = JSON.parse(await sys.readText(this.file));
      this.map = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      this.map = {};
    }
    this.dirty = false;
    const keys = Object.keys(this.map);
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_KEYS))) delete this.map[key];
    this.count = Math.min(keys.length, MAX_KEYS);
    this.dirty = keys.length > MAX_KEYS;
    this.revision++;
    return this;
  }

  // The current stamp for a path, or null when the file cannot be stat'ed.
  async stampFor(p) {
    try {
      const s = await sys.stat(p);
      return s ? stampOf(s) : null;
    } catch {
      return null;
    }
  }

  // The stored value for a path, when it was computed for exactly this stamp.
  hit(p, stamp) {
    const e = this.map[String(p).toLowerCase()];
    return e && e.stamp === stamp ? e.value : undefined;
  }

  // Remembers a value for a path at a stamp; written out by save(). Once the map
  // grows past MAX_KEYS the oldest-inserted keys are dropped back down to it.
  put(p, stamp, value) {
    const key = String(p).toLowerCase();
    const present = Object.hasOwn(this.map, key);
    Object.defineProperty(this.map, key, { value: { stamp, value }, writable: true, enumerable: true, configurable: true });
    if (!present) this.count++;
    this.dirty = true;
    this.revision++;
    if (this.count > MAX_KEYS) {
      // Enumerate only on overflow, retaining JavaScript's integer-key ordering.
      for (const k of Object.keys(this.map).slice(0, this.count - MAX_KEYS)) { delete this.map[k]; this.count--; }
    }
  }

  // Persists pending puts. Failures are swallowed: a lost cache only costs speed,
  // never correctness.
  async save() {
    if (!this.dirty) return;
    const revision = this.revision;
    try {
      await sys.writeTextAtomic(this.file, JSON.stringify(this.map));
      if (this.revision === revision) this.dirty = false;
    } catch {}
  }
}
