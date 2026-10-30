// Uninstall archive: a permanent record of every program removed with Purgeon: when,
// what was removed (its backups) and where to get it again.
import { sys } from './sys.js';
import * as path from './winpath.js';

let file = '';
export const setRoot = async (dir) => {
  await sys.makeDir(dir);
  file = path.join(dir, 'archive.json');
};

const read = () => sys.readText(file).then(JSON.parse).catch(() => []);
const write = (list) => sys.writeTextAtomic(file, JSON.stringify(list, null, 2));

export const list = async () => (await read()).sort((a, b) => b.removed.localeCompare(a.removed));

// Records a removed program. `how`: 'uninstalled' | 'forced' | 'store'.
export async function add(program, how) {
  const all = await read();
  const entry = {
    id: `${Date.now()}`,
    key: program.key || '',
    name: program.name,
    version: program.version || '',
    publisher: program.publisher || '',
    location: program.location || '',
    url: program.urlInfo || program.helpLink || '',
    store: !!program.store,
    pkgName: program.pkgName || '',
    family: program.family || '',
    how,
    removed: new Date().toISOString(),
    backups: [],
  };
  all.push(entry);
  await write(all);
  return entry;
}

// Links a removal backup to the newest archive entry of each program it removed.
export async function attachBackup(keys, backupId) {
  if (!backupId || !keys?.length) return;
  const all = await read();
  for (const k of keys) {
    let e;
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i].key && all[i].key.toLowerCase() === String(k).toLowerCase()) {
        e = all[i];
        break;
      }
    }
    if (e && !e.backups.includes(backupId)) e.backups.push(backupId);
  }
  await write(all);
}

export async function setPackage(id, wingetId) {
  const all = await read();
  const e = all.find((x) => x.id === id);
  if (e) e.wingetId = wingetId;
  await write(all);
  return e;
}

export async function remove(id) {
  await write((await read()).filter((x) => x.id !== id));
}

// ---- programs removed outside Purgeon --------------------------------------------
// The program list is remembered between runs. A program that disappeared without being
// removed here was uninstalled from Settings, its own uninstaller or another tool; it is
// recorded in the archive and returned so its leftovers can be scanned.
const knownFile = () => path.join(path.dirname(file), 'known-programs.json');

export async function outside(programs) {
  const before = await sys.readText(knownFile()).then(JSON.parse).catch(() => null);
  const now = Object.fromEntries(programs.filter((p) => p.key && !p.store).map((p) => [p.key, { key: p.key, name: p.name, version: p.version || '', publisher: p.publisher || '', location: p.location || '', urlInfo: p.urlInfo || '', icon: p.icon || '' }]));
  await sys.writeTextAtomic(knownFile(), JSON.stringify({ saved: new Date().toISOString(), programs: now }));
  if (!before?.programs) return []; // first run: nothing to compare with
  // Removed with Purgeon since the last look: already in the archive.
  const removedHere = new Set((await read()).filter((e) => e.removed >= before.saved).map((e) => String(e.key).toLowerCase()));
  const gone = Object.values(before.programs).filter((p) => !now[p.key] && !removedHere.has(p.key.toLowerCase()));
  for (const p of gone) await add(p, 'outside');
  return gone;
}
