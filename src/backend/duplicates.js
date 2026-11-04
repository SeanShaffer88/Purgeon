// Duplicate Files (Tools › Advanced Tools): finds files with identical contents under
// folders the user picks. Files are first grouped by exact size (cheap), and only the
// size-collisions are hashed with SHA-256 — a group is reported only when the hashes
// match, so same-size different files are never called duplicates.
//
// Review tool, not an automatic cleaner: nothing is pre-ticked, and removal goes to the
// Recycle Bin. The backend refuses to remove the last remaining copy of any group from
// the most recent scan, so a group can never be wiped out by accident.
import { sys } from './sys.js';
import { isProtected } from './paths.js';

export const MAX_FILES = 200000;
export const HASH_CHUNK = 200;

// Pure: [{ path, size }] -> Map(size -> [paths]) keeping only sizes with 2+ files.
export function groupBySize(files) {
  const bySize = new Map();
  for (const f of files || []) {
    if (!f?.path || !(f.size > 0)) continue;
    const list = bySize.get(f.size) || [];
    list.push(f.path);
    bySize.set(f.size, list);
  }
  for (const [size, list] of bySize) if (list.length < 2) bySize.delete(size);
  return bySize;
}

// Pure: size groups + a path->sha256 map -> duplicate groups, biggest waste first.
// A file with no hash (unreadable) never joins a group.
export function buildGroups(bySize, hashOf) {
  const groups = [];
  for (const [size, paths] of bySize) {
    const byHash = new Map();
    for (const p of paths) {
      const h = String(hashOf.get(p) || '').toLowerCase();
      if (!h) continue;
      const list = byHash.get(h) || [];
      list.push(p);
      byHash.set(h, list);
    }
    for (const [sha256, files] of byHash) {
      if (files.length < 2) continue;
      files.sort((a, b) => a.localeCompare(b));
      groups.push({ sha256, size, files, wasted: size * (files.length - 1) });
    }
  }
  return groups.sort((a, b) => b.wasted - a.wasted);
}

// Pure guard: the paths that may NOT be removed because each is the last copy of its
// group once the other selected paths are gone.
export function lastCopies(groups, selected) {
  const chosen = new Set((selected || []).map((p) => String(p).toLowerCase()));
  const blocked = [];
  for (const g of groups || []) {
    const remaining = g.files.filter((p) => !chosen.has(p.toLowerCase()));
    if (remaining.length === 0) blocked.push(...g.files);
  }
  return blocked;
}

let lastScan = null;
let pending = Promise.resolve();
const serialize = (run) => {
  const result = pending.then(run);
  pending = result.catch(() => {});
  return result;
};
export const lastGroups = () => (lastScan?.groups || []).map((g) => ({ ...g, files: [...g.files] }));

export const scan = (roots, shouldStop) => serialize(() => scanFiles(roots, shouldStop));
async function scanFiles(roots, shouldStop) {
  const cleanRoots = [...new Set((roots || []).filter((r) => r && !isProtected(r)))];
  if (!cleanRoots.length) return { groups: [], scanned: 0, truncated: false, error: 'Choose a folder to scan. Protected locations (Windows, Program Files, your profile folders) are not scanned.' };
  await sys.beginScans?.().catch(() => {});
  const entries = await sys.walk(cleanRoots, 40, 40);
  const files = [];
  const seen = new Set();
  let truncated = false;
  for (const e of entries) {
    if (shouldStop?.()) { truncated = true; break; }
    if (!e.startsWith('F')) continue;
    if (files.length >= MAX_FILES) { truncated = true; break; }
    const p = e.slice(1);
    if (!seen.has(p.toLowerCase())) { files.push(p); seen.add(p.toLowerCase()); }
  }
  const sized = [];
  for (const p of files) {
    const st = await sys.stat(p).catch(() => null);
    if (st && !st.dir && st.size > 0) sized.push({ path: p, size: st.size });
  }
  const bySize = groupBySize(sized);
  const candidates = [...bySize.values()].flat();
  const hashOf = new Map();
  for (let i = 0; i < candidates.length; i += HASH_CHUNK) {
    if (shouldStop?.()) { truncated = true; break; }
    const chunk = candidates.slice(i, i + HASH_CHUNK);
    const hashes = await sys.sha256Files(chunk).catch(() => []);
    chunk.forEach((p, j) => { if (hashes?.[j]) hashOf.set(p, hashes[j]); });
  }
  const groups = buildGroups(bySize, hashOf);
  lastScan = { groups: groups.map((g) => ({ ...g, files: [...g.files] })), at: new Date().toISOString() };
  return { groups, scanned: sized.length, truncated };
}

// Sends the selected copies to the Recycle Bin. Refuses (a) paths that are not in the
// most recent scan, (b) protected locations, and (c) any selection that would remove
// every copy of a group.
export const remove = (paths) => serialize(() => removeFiles(paths));
const metadata = (st) => st && !st.dir && !st.link ? JSON.stringify([st.size, st.created, st.modified]) : null;
async function removeFiles(paths) {
  const groups = lastScan?.groups || [];
  if (!groups.length) return { ok: false, error: 'Run a scan first, then choose copies to remove.' };
  const known = new Map();
  for (const g of groups) for (const p of g.files) known.set(p.toLowerCase(), p);
  const wanted = [...new Set((paths || []).map((p) => known.get(String(p).toLowerCase())).filter(Boolean))];
  if (!wanted.length) return { ok: false, error: 'None of the chosen files are in the last scan.' };
  if (wanted.some((p) => isProtected(p))) return { ok: false, error: 'One of the chosen files is in a protected location and was not removed.' };
  const blocked = lastCopies(groups, wanted);
  if (blocked.length) return { ok: false, error: `Keep at least one copy of each file — ${blocked[0]} is the last copy of its group.` };
  const selected = new Set(wanted.map((p) => p.toLowerCase()));
  const affected = groups.filter((g) => g.files.some((p) => selected.has(p.toLowerCase())));
  const checked = new Map();
  for (const group of affected) {
    for (let i = 0; i < group.files.length; i += HASH_CHUNK) {
      const chunk = group.files.slice(i, i + HASH_CHUNK);
      const before = await Promise.all(chunk.map((p) => sys.stat(p).catch(() => null)));
      const hashes = await sys.sha256Files(chunk).catch(() => []);
      const after = await Promise.all(chunk.map((p) => sys.stat(p).catch(() => null)));
      chunk.forEach((p, j) => {
        const stamp = metadata(before[j]);
        if (Array.isArray(hashes) && hashes.length === chunk.length && stamp && before[j].size === group.size && stamp === metadata(after[j]) &&
            typeof hashes?.[j] === 'string' && /^[0-9a-f]{64}$/i.test(hashes[j]) && hashes[j].toLowerCase() === group.sha256) checked.set(p, stamp);
      });
    }
  }
  const results = [];
  for (const p of wanted) {
    try {
      const group = affected.find((g) => g.files.includes(p));
      const survivor = group.files.find((f) => !selected.has(f.toLowerCase()) && checked.has(f));
      if (!checked.has(p) || !survivor) throw new Error('The target or a remaining copy could not be verified. Run a new scan before removing it.');
      const targetNow = await sys.stat(p);
      const survivorNow = await sys.stat(survivor);
      if (metadata(targetNow) !== checked.get(p) || metadata(survivorNow) !== checked.get(survivor)) {
        checked.delete(p);
        checked.delete(survivor);
        throw new Error('A duplicate changed during verification. Run a new scan before removing it.');
      }
      await sys.trash(p);
      group.files = group.files.filter((f) => f.toLowerCase() !== p.toLowerCase());
      group.wasted = group.size * Math.max(0, group.files.length - 1);
      results.push({ path: p, ok: true });
    } catch (e) {
      results.push({ path: p, ok: false, error: String(e?.message ?? e) });
    }
  }
  return { ok: results.every((r) => r.ok), results, removed: results.filter((r) => r.ok).length };
}
