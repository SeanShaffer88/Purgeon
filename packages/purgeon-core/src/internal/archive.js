// Uninstall archive: a permanent record of every program removed with Purgeon: when,
// what was removed (its backups) and where to get it again.
import { sys } from './sys.js';
import * as path from './winpath.js';

let file = '';
export const setRoot = async (dir) => {
  await sys.makeDir(dir);
  file = path.join(dir, 'archive.json');
};

let pending = Promise.resolve();
const serialize = (run) => {
  const result = pending.then(run);
  pending = result.catch(() => {});
  return result;
};
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const strings = (value, fields) => fields.every((field) => !(field in value) || typeof value[field] === 'string');
function validateArchive(all) {
  if (!Array.isArray(all) || !all.every((e) => object(e) && typeof e.name === 'string' && typeof e.removed === 'string' &&
      strings(e, ['id', 'key', 'version', 'publisher', 'location', 'url', 'pkgName', 'family', 'how', 'wingetId']) &&
      (!('store' in e) || typeof e.store === 'boolean') &&
      (!('backups' in e) || (Array.isArray(e.backups) && e.backups.every((id) => typeof id === 'string'))))) {
    throw new Error('Invalid archive schema');
  }
  return all;
}
async function readStore(target, validate, absent) {
  try {
    const text = await sys.readOptionalText(target);
    if (text === null) return absent;
    if (typeof text !== 'string') throw new Error('Invalid stored text');
    return validate(JSON.parse(text));
  } catch (error) {
    throw new Error(`Cannot read ${target}: ${error.message}. Existing evidence was preserved; restore a valid copy before retrying.`);
  }
}
const read = () => readStore(file, validateArchive, []);
const encode = (all) => {
  validateArchive(all);
  const text = JSON.stringify(all, null, 2);
  validateArchive(JSON.parse(text));
  return text;
};
const write = (all) => sys.writeTextAtomic(file, encode(all));

export const list = async () => (await read()).sort((a, b) => b.removed.localeCompare(a.removed));

// Records a removed program. `how`: 'uninstalled' | 'forced' | 'store'.
function makeEntry(program, how) {
  if (!object(program) || typeof program.name !== 'string' ||
      !strings(program, ['key', 'version', 'publisher', 'location', 'urlInfo', 'helpLink', 'pkgName', 'family']) ||
      typeof how !== 'string') throw new Error('Invalid archive entry');
  return {
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
}
export const add = (program, how) => serialize(async () => {
  const all = await read();
  const entry = makeEntry(program, how);
  all.push(entry);
  await write(all);
  return entry;
});

// Links a removal backup to the newest archive entry of each program it removed.
export const attachBackup = (keys, backupId) => serialize(async () => {
  if (!backupId || !keys?.length) return;
  if (typeof backupId !== 'string' || !Array.isArray(keys) || keys.some((key) => typeof key !== 'string')) throw new Error('Invalid archive backup reference');
  const all = await read();
  for (const k of keys) {
    let e;
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i].key && all[i].key.toLowerCase() === String(k).toLowerCase()) {
        e = all[i];
        break;
      }
    }
    if (e) {
      e.backups ??= [];
      if (!e.backups.includes(backupId)) e.backups.push(backupId);
    }
  }
  await write(all);
});

export const setPackage = (id, wingetId) => serialize(async () => {
  if (typeof id !== 'string' || !id || typeof wingetId !== 'string') throw new Error('Invalid archive package reference');
  const all = await read();
  const e = all.find((x) => x.id === id);
  if (e) e.wingetId = wingetId;
  await write(all);
  return e;
});

export const remove = (id) => serialize(async () => {
  if (typeof id !== 'string' || !id) throw new Error('Invalid archive id');
  await write((await read()).filter((x) => x.id !== id));
});

// ---- programs removed outside Purgeon --------------------------------------------
// The program list is remembered between runs. A program that disappeared without being
// removed here was uninstalled from Settings, its own uninstaller or another tool; it is
// recorded in the archive and returned so its leftovers can be scanned.
const knownFile = () => path.join(path.dirname(file), 'known-programs.json');

function validateKnown(value) {
  if (!object(value) || typeof value.saved !== 'string' || !Number.isFinite(Date.parse(value.saved)) || !object(value.programs) ||
      !Object.values(value.programs).every((p) => object(p) && typeof p.key === 'string' && p.key && typeof p.name === 'string' &&
        strings(p, ['version', 'publisher', 'location', 'urlInfo', 'icon']))) throw new Error('Invalid known-programs schema');
  return value;
}
export const outside = (programs) => serialize(async () => {
  const all = await read();
  const before = await readStore(knownFile(), validateKnown, null);
  const now = Object.fromEntries(programs.filter((p) => p.key && !p.store).map((p) => [p.key, { key: p.key, name: p.name, version: p.version || '', publisher: p.publisher || '', location: p.location || '', urlInfo: p.urlInfo || '', icon: p.icon || '' }]));
  const baseline = { ...before, saved: new Date().toISOString(), programs: now };
  validateKnown(baseline);
  const baselineText = JSON.stringify(baseline);
  validateKnown(JSON.parse(baselineText));
  const removedHere = new Set(all.filter((e) => before && e.removed >= before.saved).map((e) => String(e.key).toLowerCase()));
  const current = new Set(Object.keys(now).map((key) => key.toLowerCase()));
  const gone = before ? Object.values(before.programs).filter((p) => !current.has(p.key.toLowerCase()) && !removedHere.has(p.key.toLowerCase())) : [];
  const archiveText = encode([...all, ...gone.map((p) => makeEntry(p, 'outside'))]);
  if (gone.length) await sys.writeTextAtomic(file, archiveText);
  try {
    await sys.writeTextAtomic(knownFile(), baselineText);
  } catch (error) {
    throw new Error(`Known-programs baseline save failed: ${error.message}. Any archive additions remain saved; completion is incomplete. Retry to update the baseline.`);
  }
  return gone;
});
