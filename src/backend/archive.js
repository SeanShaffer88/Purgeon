// Uninstall archive: a permanent record of every program removed with SweepUninstall: when,
// what was removed (its backups) and where to get it again.
import { sys } from './sys.js';
import * as path from './winpath.js';

let file = '';
export const setRoot = async (dir) => {
  await sys.makeDir(dir);
  file = path.join(dir, 'archive.json');
};

const read = () => sys.readText(file).then(JSON.parse).catch(() => []);
const write = (list) => sys.writeText(file, JSON.stringify(list, null, 2));

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
    const e = [...all].reverse().find((x) => x.key && x.key.toLowerCase() === String(k).toLowerCase());
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
