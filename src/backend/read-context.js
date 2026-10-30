import { sys } from './sys.js';
import { stampOf } from './filecache.js';

export async function forEachRead(items, visit) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(6, items.length) }, async () => {
    while (next < items.length) { const index = next++; await visit(items[index], index); }
  }));
}

// Lifetime is one immutable read request. Never reuse for mutation prechecks.
export function createReadContext() {
  const stamps = new Map();
  return { stampFor(path) {
    const key = String(path).toLowerCase();
    if (!stamps.has(key)) stamps.set(key, Promise.resolve().then(() => sys.stat(path)).then((value) => value ? stampOf(value) : null).catch(() => null));
    return stamps.get(key);
  } };
}
