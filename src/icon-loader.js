export const iconIdentity = (row) => JSON.stringify([row.key, row.icon || '', row.uninstall || '', row.location || '', row.version || '']);

// Coalesces only identical inventory identities; this cache is never mutation authority.
export function createIconLoader(fetch) {
  const cache = new Map(), flights = new Map();
  let active = new Set();
  return {
    retain(rows) {
      active = new Set(rows.map(iconIdentity));
      for (const key of cache.keys()) if (!active.has(key)) cache.delete(key);
    },
    async load(rows) {
      const fresh = rows.filter((row) => !cache.has(iconIdentity(row)) && !flights.has(iconIdentity(row)));
      if (fresh.length) {
        const batch = Promise.resolve().then(() => fetch(fresh));
        for (const row of fresh) {
          const key = iconIdentity(row);
          if (flights.has(key)) continue;
          const pending = batch.then((found) => {
            const value = found?.[row.key] || null;
            if (active.has(key)) cache.set(key, value);
            return value;
          }).finally(() => { if (flights.get(key) === pending) flights.delete(key); });
          flights.set(key, pending);
        }
      }
      const found = await Promise.all(rows.map(async (row) => {
        const key = iconIdentity(row);
        return [row.key, cache.has(key) ? cache.get(key) : await flights.get(key)];
      }));
      return Object.fromEntries(found);
    },
  };
}
