// Shared Components (Tools › Advanced Tools): what Purgeon refuses to delete
// during a removal, and why. Everything here is evidence the system itself
// records — the SharedDLLs refcounts Windows keeps, install locations that
// several programs share, and the shared-runtime names the safety guard
// already uses. Where Windows records a count but not names, the window says
// exactly that instead of guessing a list.
import * as path from './winpath.js';
import { readState, RUNTIMES } from './safety.js';

const cleanDir = (p) => String(p || '').replace(/^"|"$/g, '').trim().replace(/\\+$/, '');

// Shapes the safety state into the component list. Pure, so it is testable
// without a live system: state is readState()'s { programs, shared }.
export function buildComponents(state) {
  const programs = (state?.programs || []).filter((p) => p && p.name);
  const out = [];

  // Shared runtimes: installed programs whose name marks them as a runtime
  // other programs start on top of.
  for (const p of programs) {
    if (RUNTIMES.test(p.name)) {
      out.push({
        kind: 'runtime',
        name: p.name,
        path: cleanDir(p.location),
        tag: 'shared runtime',
        detail: 'Other programs may need this to start. Purgeon never removes a shared runtime as part of another program’s cleanup, and removing it here is not offered — uninstall it from the main list only after checking the programs you keep.',
        dependents: [],
      });
    }
  }

  // Shared folders: one install location used by several programs, or
  // several programs installed under the same Common Files parent.
  const byLocation = new Map();
  for (const p of programs) {
    const loc = cleanDir(p.location);
    if (!/^[a-z]:\\/i.test(loc)) continue;
    const key = loc.toLowerCase();
    if (!byLocation.has(key)) byLocation.set(key, { path: loc, names: [] });
    byLocation.get(key).names.push(p.name);
  }
  const folderSeen = new Set();
  const addFolder = (folderPath, names) => {
    const key = folderPath.toLowerCase();
    if (folderSeen.has(key) || names.length < 2) return;
    folderSeen.add(key);
    out.push({
      kind: 'folder',
      name: path.basename(folderPath) || folderPath,
      path: folderPath,
      tag: `${names.length} programs inside`,
      detail: 'These programs share this folder, so the folder is kept whenever any one of them is removed.',
      dependents: [...names].sort(),
    });
  };
  for (const { path: loc, names } of byLocation.values()) addFolder(loc, names);
  const byParent = new Map();
  for (const p of programs) {
    const loc = cleanDir(p.location);
    if (!/common files\\/i.test(loc)) continue;
    const parent = path.dirname(loc);
    const key = parent.toLowerCase();
    if (!byParent.has(key)) byParent.set(key, { path: parent, names: [] });
    byParent.get(key).names.push(p.name);
  }
  for (const { path: fp, names } of byParent.values()) addFolder(fp, names);

  // Shared files: the SharedDLLs refcounts — Windows records HOW MANY
  // programs use each file, never which ones.
  const files = (state?.shared || [])
    .filter((s) => s && s.path && s.count >= 2)
    .sort((a, b) => b.count - a.count)
    .slice(0, 300);
  for (const s of files) {
    out.push({
      kind: 'file',
      name: path.basename(s.path),
      path: s.path,
      count: s.count,
      tag: `used by ${s.count}`,
      detail: `Windows records ${s.count} programs using this file, but does not record which ones — so no list can be shown. The file is kept whenever a removal touches it.`,
      dependents: [],
    });
  }

  const rank = { runtime: 0, folder: 1, file: 2 };
  return out.sort((a, b) => rank[a.kind] - rank[b.kind] || (a.kind === 'file' ? b.count - a.count : a.name.localeCompare(b.name)));
}

export async function components() {
  return buildComponents(await readState());
}
