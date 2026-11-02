// Only portable, non-security preferences may cross machines. Baselines stay local.
import { sys } from './sys.js';
import * as path from './winpath.js';
import { readSettings, writeSettings } from './settings.js';
import { canonical } from './contracts.js';
import { validateTarget } from './import-policy.js';
let syncRoot = '';
let enabled = false;
let chain = Promise.resolve();
let configError = '';
const fields = { theme: (v) => ['dark', 'light', 'contrast'].includes(v), language: (v) => v === 'en', textScale: (v) => Number.isFinite(v) && v >= 0.75 && v <= 2, reducedMotion: (v) => typeof v === 'boolean', gridLines: (v) => typeof v === 'boolean' };
const defaults = { theme: 'dark', language: 'en', textScale: 1, reducedMotion: false, gridLines: true };
export const preferences = (s) => ({ ...defaults, ...Object.fromEntries(Object.entries(s).filter(([k, v]) => Object.hasOwn(fields, k) && fields[k](v))) });
const parse = (text) => { if (text.length > 65536) throw new Error('Sync settings are too large'); const value = JSON.parse(text); if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Invalid sync settings'); return preferences(value); };
const baselinePath = () => path.join(sys.info.dataDir, 'sync-baseline.json');
const targetPath = () => path.join(syncRoot, 'settings.json');
export function validateSyncFolder(folder) {
  if (typeof folder !== 'string' || !/^[a-z]:[\\/]/i.test(folder)) throw new Error('Choose an absolute local sync folder');
  const candidate = path.resolve(folder).replace(/\\+$/, '');
  validateTarget(path.join(candidate, 'settings.json'), 'file');
  const key = candidate.toLowerCase();
  const local = path.resolve(sys.info.dataDir).replace(/\\+$/, '').toLowerCase();
  if (key === local || key.startsWith(local + '\\') || local.startsWith(key + '\\')) throw new Error('Sync must use a folder separate from Purgeon application data');
  return candidate;
}
const readRemote = async () => { if (!(await sys.exists(targetPath()))) return null; return parse(await sys.readText(targetPath())); };
async function baseline() {
  if (!(await sys.exists(baselinePath()))) return null;
  const b = JSON.parse(await sys.readText(baselinePath()));
  return b.folder === syncRoot ? preferences(b.preferences) : null;
}
export const setRoot = async (dir) => { syncRoot = dir; await sys.makeDir(dir); };
export const setEnabled = (on) => { enabled = on === true; };
export const isEnabled = () => enabled;
export const root = () => syncRoot;
export async function status() {
  let conflict = false, error = configError, firstConnection = false;
  try {
    const [local, remote, base] = await Promise.all([readSettings().then(preferences), readRemote(), baseline()]);
    firstConnection = remote !== null && base === null;
    conflict = remote !== null && canonical(local) !== canonical(remote) && (!base || canonical(local) !== canonical(base) && canonical(remote) !== canonical(base));
  } catch (e) { error = String(e.message || e); }
  const st = syncRoot ? await sys.stat(targetPath()).catch(() => null) : null;
  return { enabled, folder: syncRoot, lastSync: st?.modified || '', conflict, firstConnection, error, syncFiles: ['settings.json'] };
}
export async function apply({ folder, on, files, direction } = {}) {
  if (files && (files.length !== 1 || files[0] !== 'settings.json')) throw new Error('Only settings.json preferences can be synced');
  if (folder) {
    const next = validateSyncFolder(folder);
    await sys.makeDir(next); syncRoot = next; configError = '';
  }
  if (on !== undefined) enabled = on === true;
  if (enabled) validateSyncFolder(syncRoot);
  await writeSettings({ syncFolder: syncRoot, syncOn: enabled });
  if (enabled && syncRoot) await syncNow({ direction });
  return status();
}
export async function restore() {
  const s = await readSettings();
  enabled = false;
  if (s.syncFolder) {
    try { syncRoot = validateSyncFolder(s.syncFolder); configError = ''; enabled = s.syncOn === true; }
    catch (e) { configError = String(e.message || e); }
  }
  if (enabled && syncRoot) await syncNow();
}
export function syncNow(options = {}) {
  const run = chain.then(() => perform(options), () => perform(options));
  chain = run.catch(() => {});
  return run;
}
async function perform({ direction } = {}) {
  if (!enabled || !syncRoot) return { synced: 0, errors: [], conflicts: [] };
  validateSyncFolder(syncRoot);
  if (direction && !['pull', 'push'].includes(direction)) throw new Error('Choose pull or push');
  const local = preferences(await readSettings());
  const remote = await readRemote();
  const base = await baseline();
  let next = local;
  if (remote !== null && canonical(local) !== canonical(remote)) {
    if (direction === 'pull') next = remote;
    else if (direction === 'push') next = local;
    else if (!base) return { synced: 0, errors: [], conflicts: ['settings.json'], firstConnection: true };
    else {
      const conflicts = [];
      next = { ...local };
      for (const k of new Set([...Object.keys(local), ...Object.keys(remote), ...Object.keys(base)])) {
        const l = JSON.stringify(local[k]), r = JSON.stringify(remote[k]), b = JSON.stringify(base[k]);
        if (l !== r && l !== b && r !== b) conflicts.push(k);
        else if (l === b) { if (remote[k] === undefined) delete next[k]; else next[k] = remote[k]; }
      }
      if (conflicts.length) return { synced: 0, errors: [], conflicts };
    }
  }
  if (canonical(next) !== canonical(local)) await writeSettings(next);
  await sys.writeTextAtomic(targetPath(), JSON.stringify(next, null, 2));
  await sys.writeTextAtomic(baselinePath(), JSON.stringify({ folder: syncRoot, preferences: next }, null, 2));
  return { synced: 1, errors: [], conflicts: [] };
}
