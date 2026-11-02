// Duplicate Programs (Tools › Advanced Tools): finds programs that look like duplicates
// of each other — the same program installed twice (two versions side by side, or the
// same version in two places). Name matching is deliberately conservative: the name is
// reduced to its core (version numbers, "x64"/"64-bit" tags and edition words removed)
// and only exact core matches are grouped, so different products are never paired.
// A review list only: removing stays in the main program list, one program at a time,
// through the normal backed-up uninstall.
import * as programs from './programs.js';

const EDITION_WORDS = /\b(community|professional|enterprise|standard|edition|free|trial|beta|alpha|preview|portable|x64|x86|64[- ]bit|32[- ]bit|win64|win32)\b/g;

// Pure: a program name reduced to the part that identifies the product.
export function coreName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\(?\bv?\d+(\.\d+){1,3}\b\)?/g, ' ') // version numbers, with or without brackets
    .replace(/\(?(x64|x86|64-bit|32-bit)\)?/g, ' ')
    .replace(EDITION_WORDS, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Pure: desktop programs -> duplicate groups. An entry needs a core name of at least
// 3 characters (short names collide too easily to accuse).
export function findDuplicates(list) {
  const byCore = new Map();
  for (const p of list || []) {
    if (!p?.key || p.store) continue;
    const core = coreName(p.name);
    if (core.length < 3) continue;
    const group = byCore.get(core) || [];
    group.push(p);
    byCore.set(core, group);
  }
  const groups = [];
  for (const [core, entries] of byCore) {
    if (entries.length < 2) continue;
    const versions = new Set(entries.map((e) => String(e.version || '')));
    const locations = new Set(entries.map((e) => String(e.location || '').toLowerCase()));
    groups.push({
      core,
      kind: versions.size > 1 ? 'versions' : locations.size > 1 ? 'copies' : 'entries',
      entries: entries.map((e) => ({ key: e.key, name: e.name, version: e.version || '', publisher: e.publisher || '', location: e.location || '' })),
    });
  }
  return groups.sort((a, b) => a.core.localeCompare(b.core));
}

export async function scan() {
  const list = await programs.listDesktop();
  return findDuplicates(list);
}
