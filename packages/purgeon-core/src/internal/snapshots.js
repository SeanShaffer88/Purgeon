// Snapshots: named records of files/folders and registry keys/values, taken at any time and
// compared with each other or with the system as it is now. A comparison's differences can be
// cleaned up: added items are removed, and changed or removed registry values and keys are put
// back from the earlier snapshot. Cleanups go through backups.removeItems, so they are backed up
// and can be undone from Change History.
import { sys, env, homeDir } from './sys.js';
import * as path from './winpath.js';
import { fileRoots, shortcutRoots, isProtectedKey, isProtected } from './paths.js';

export const PRESETS = {
  quick: { label: 'Quick', fileDepth: 4, regDepth: 4, hint: 'a few seconds' },
  standard: { label: 'Standard', fileDepth: 6, regDepth: 6, hint: 'about 10–20 seconds' },
  deep: { label: 'Deep', fileDepth: 10, regDepth: 10, hint: 'a minute or more' },
};

// Folders and keys that change constantly and say nothing about installed programs.
const NOISE = [
  '\\temp\\', '\\tmp\\', '\\inetcache\\', '\\inetcookies', '\\cache\\', '\\cache2\\', '\\code cache\\', '\\gpucache\\', '\\shadercache\\',
  '\\crashdumps\\', '\\crashpad\\', '\\package cache\\', '\\windowsapps\\', '\\packages\\', '\\d3dscache\\', '\\dxcache', '\\service worker\\',
  '\\microsoft\\windows\\explorer\\', '\\microsoft\\windows\\recent', '\\logs\\', '\\.cache\\',
  '\\software\\classes\\local settings\\', '\\currentversion\\explorer\\userassist', '\\currentversion\\explorer\\recentdocs',
  '\\currentversion\\explorer\\sessioninfo', '\\currentversion\\explorer\\featureusage', '\\currentversion\\explorer\\comdlg32',
  '\\currentversion\\explorer\\streams', '\\microsoft\\windows\\shell\\bags', '\\microsoft\\windows\\shell\\bagmru',
];

let dir = '';
export const setRoot = async (d) => {
  dir = d;
  await sys.makeDir(dir);
};

const snapFile = (id) => path.join(dir, `${id}.snap`);
const metaFile = (id) => path.join(dir, `${id}.json`);
const validId = (id) => /^\d+$/.test(String(id));

function scope(preset) {
  const p = PRESETS[preset] || PRESETS.standard;
  const roots = [...new Set([...fileRoots(), ...shortcutRoots()].map((r) => r.replace(/\\+$/, '')))];
  // Leave out roots nested inside other roots, so nothing is listed twice.
  const fileRootsTop = roots.filter((r) => !roots.some((o) => o !== r && r.toLowerCase().startsWith(o.toLowerCase() + '\\')));
  const own = [sys.info.dataDir, env('LOCALAPPDATA') && path.join(env('LOCALAPPDATA'), 'com.seanshaffer.sweepuninstall')].filter(Boolean).map((d) => d.toLowerCase());
  return {
    fileRoots: fileRootsTop,
    fileDepth: p.fileDepth,
    regRoots: [
      { hive: 'HKLM', path: 'SOFTWARE', depth: p.regDepth },
      { hive: 'HKCU', path: 'Software', depth: p.regDepth },
      { hive: 'HKLM', path: 'SYSTEM\\CurrentControlSet\\Services', depth: 2 },
    ],
    excludes: [...NOISE, ...own],
  };
}

// The native layer reports a user cancel as an error with the exact message
// "cancelled"; anywhere else it would surface as a scary failure, so it is
// mapped here to a plain { cancelled: true } result.
const isCancel = (e) => String((e && e.message) || e) === 'cancelled';

export async function capture(out, name, preset) {
  const s = scope(preset);
  try {
    return await sys.takeSnapshot(out, name, s.fileRoots, s.fileDepth, s.regRoots, s.excludes);
  } catch (e) {
    if (isCancel(e)) return { cancelled: true };
    throw e;
  }
}

export async function take(name, preset = 'standard') {
  const id = String(Date.now());
  const stats = await capture(snapFile(id), name, preset);
  if (stats.cancelled) return { cancelled: true };
  const meta = { id, name: name || `Snapshot ${new Date().toLocaleString()}`, created: new Date().toISOString(), preset, stats };
  await sys.writeTextAtomic(metaFile(id), JSON.stringify(meta, null, 2));
  return meta;
}

export async function list() {
  const files = (await sys.readDir(dir).catch(() => [])).filter((f) => f.file && /^\d+\.json$/.test(f.name));
  const metas = await Promise.all(files.map((f) => sys.readText(path.join(dir, f.name)).then(JSON.parse).catch(() => null)));
  return metas.filter(Boolean).sort((a, b) => b.created.localeCompare(a.created));
}

export async function remove(id) {
  if (!validId(id)) throw new Error('Invalid snapshot id');
  // To the Recycle Bin, not a hard delete, so a snapshot deleted by mistake can be brought back.
  for (const f of [snapFile(id), metaFile(id)]) if (await sys.exists(f)) await sys.trash(f);
}

export async function rename(id, name) {
  if (!validId(id)) throw new Error('Invalid snapshot id');
  const meta = JSON.parse(await sys.readText(metaFile(id)));
  meta.name = name;
  await sys.writeTextAtomic(metaFile(id), JSON.stringify(meta, null, 2));
  return meta;
}

// Compares snapshot `before` with snapshot `after`, or with the system now (after = 'now').
export async function compare(before, after, limit = 20000) {
  if (!validId(before) || (after !== 'now' && !validId(after))) throw new Error('Invalid snapshot id');
  const beforeMeta = JSON.parse(await sys.readText(metaFile(before)));
  let afterPath = snapFile(after);
  if (after === 'now') {
    afterPath = path.join(dir, 'now.snap');
    const fresh = await capture(afterPath, 'Now', beforeMeta.preset);
    if (fresh.cancelled) return { cancelled: true };
  }
  let result;
  try {
    result = await sys.compareSnapshots(snapFile(before), afterPath, limit);
  } catch (e) {
    if (after === 'now') await sys.removePath(afterPath).catch(() => {});
    if (isCancel(e)) return { cancelled: true };
    throw e;
  }
  if (after === 'now') await sys.removePath(afterPath);
  return { ...result, beforeId: String(before), afterId: String(after), preset: beforeMeta.preset };
}

const REG_TYPES = { 1: 'REG_SZ', 2: 'REG_EXPAND_SZ', 3: 'REG_BINARY', 4: 'REG_DWORD', 7: 'REG_MULTI_SZ', 11: 'REG_QWORD' };

// Snapshot data can be written back only for the common value types, and only when stored in full.
export const revertible = (valueType, data) => data != null && !String(data).startsWith('#') && !!REG_TYPES[valueType];

// Snapshot text fields escape \ \t \n \r and NUL. For REG_MULTI_SZ the NUL separators become reg.exe's
// "\0" separator; other strings are unescaped fully.
function unescape(text, keepNul) {
  return String(text).replace(/\\(.)/g, (_, c) => (c === 't' ? '\t' : c === 'n' ? '\n' : c === 'r' ? '\r' : c === '0' ? (keepNul ? '\\0' : '') : c));
}

// reg.exe arguments that write a value from snapshot data.
export function regAddArgs(key, name, valueType, data) {
  const type = REG_TYPES[valueType];
  if (!type || !revertible(valueType, data)) return null;
  const d = valueType === 1 || valueType === 2 ? unescape(data, false) : valueType === 7 ? unescape(data, true) : String(data);
  return ['add', key, ...(name ? ['/v', name] : ['/ve']), '/t', type, '/d', d, '/f'];
}

// Turns selected differences into reversible cleanup items for backups.removeItems.
// Each selected change has { group: 'added' | 'removed' | 'changed', kind, path, name?, valueType?, before? }.
export async function cleanupItems(before, selected) {
  const items = [];
  for (const c of selected) {
    if (c.group === 'added') {
      if ((c.kind === 'dir' || c.kind === 'file') && !isProtected(c.path)) items.push({ kind: c.kind, path: c.path, confidence: 'high', reason: 'Added since the snapshot' });
      else if (c.kind === 'key' && !isProtectedKey(c.path)) items.push({ kind: 'key', path: c.path, confidence: 'high', reason: 'Added since the snapshot' });
      else if (c.kind === 'value') items.push({ kind: 'value', path: c.path, name: c.name, confidence: 'high', reason: 'Added since the snapshot' });
    } else if (c.kind === 'value' && revertible(c.valueType, c.before)) {
      items.push({ kind: 'setvalue', path: c.path, name: c.name, valueType: c.valueType, data: c.before, confidence: 'high', reason: c.group === 'changed' ? 'Put back the earlier value' : 'Recreate the removed value' });
    } else if (c.group === 'removed' && c.kind === 'key') {
      const tree = await sys.snapshotSubtree(snapFile(before), c.path);
      for (const k of tree.keys) items.push({ kind: 'createkey', path: k, confidence: 'high', reason: 'Recreate the removed key' });
      for (const v of tree.values) {
        if (revertible(v.valueType, v.before)) items.push({ kind: 'setvalue', path: v.path, name: v.name, valueType: v.valueType, data: v.before, confidence: 'high', reason: 'Recreate the removed value' });
      }
    }
  }
  return items;
}
