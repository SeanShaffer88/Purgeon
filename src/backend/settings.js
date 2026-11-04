// Centralized settings I/O so multiple modules don't each re-implement it.
// Also breaks the circular import cycle: trusted.js/updatecheck.js/sync.js
// previously imported readSettings from api.js, which imported them back.
import { sys } from './sys.js';
import * as path from './winpath.js';
import * as datadamage from './datadamage.js';

export const DEFAULT_SETTINGS = {
  language: 'en',
  createRestorePoints: true,
  silentUninstall: false,
  safeMode: false,
  backupMaxDays: 0,
  backupMaxMB: 0,
  gridLines: true,
  requireSignature: false,
  disabledConfirmations: [],
  textScale: 1,
  reducedMotion: false,
  watchStartupEntries: false,
  detectInstallers: false,
  startupMonitoring: false,
  resourceAlerts: false,
  recordSizeHistory: false,
  alertThresholds: { cpu: 90, mem: 90, diskFreeGB: 20 },
};

export const settingsFile = () => path.join(sys.info.dataDir, 'settings.json');
const clone = (value) => JSON.parse(JSON.stringify(value));

// Settings are read by many backend calls, so the parsed file is cached and only
// re-read when the file's modified time changes; edits made outside the app are
// still picked up, and the app's own writes refresh the cache directly.
let cachedValue = null;
let cachedMtime = null;
let cachedFile = null;
const invalidateCache = () => { cachedValue = null; cachedMtime = null; cachedFile = null; };
const plainSettings = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const statMtime = async (file) => {
  try { const stamp = (await sys.stat(file))?.modified; return typeof stamp === 'number' && Number.isFinite(stamp) ? stamp : null; }
  catch { return null; } // Metadata is only a cache hint; the strict read decides absence.
};
async function refreshCache(next, file = settingsFile()) {
  const mtime = await statMtime(file);
  if (mtime === null) { invalidateCache(); return; }
  cachedValue = clone({ ...DEFAULT_SETTINGS, ...next }); cachedMtime = mtime; cachedFile = file;
}
async function readSettingsInternal({ fresh = false, serialized = false } = {}) {
  const file = settingsFile(), mtime = await statMtime(file);
  if (!fresh && mtime !== null && cachedValue && cachedFile === file && cachedMtime === mtime) return clone(cachedValue);
  try {
    const text = await sys.readOptionalText(file);
    if (text === null) { invalidateCache(); return clone(DEFAULT_SETTINGS); }
    if (typeof text !== 'string') throw new Error('Invalid optional settings read response');
    let parsed;
    try { parsed = JSON.parse(text); if (!plainSettings(parsed)) throw new Error('Settings must be an object'); }
    catch {
      // Preserve and verify damaged bytes before replacing the original with defaults.
      invalidateCache();
      if (!serialized) return await serializeWrite(() => readSettingsInternal({ fresh: true, serialized: true }));
      const copy = await datadamage.quarantine(file, text);
      if (await sys.readOptionalText(copy) !== text) throw new Error('Damaged settings copy could not be verified; original settings were retained');
      const value = clone(DEFAULT_SETTINGS);
      await sys.writeTextAtomic(file, JSON.stringify(value, null, 2));
      await refreshCache(value, file);
      return clone(value);
    }
    const value = { ...clone(DEFAULT_SETTINGS), ...parsed, language: 'en' };
    // Migrate legacy plaintext only after a successful, valid data read.
    if (typeof value.encryptionKey === 'string' && value.encryptionKey) {
      if (!serialized) return await serializeWrite(() => readSettingsInternal({ fresh: true, serialized: true }));
      if (!sys.secretSet) throw new Error('Secure secret storage is unavailable; settings migration stopped');
      await sys.secretSet(value.encryptionKey); delete value.encryptionKey;
      await sys.writeTextAtomic(file, JSON.stringify(value, null, 2));
      await refreshCache(value, file);
    } else if (mtime !== null) { cachedValue = value; cachedMtime = mtime; cachedFile = file; }
    else invalidateCache();
    return clone(value);
  } catch (error) { invalidateCache(); throw new Error(`Settings could not be read or preserved: ${error.message}. Restore access or review the retained settings before changing them.`); }
}
export const readSettings = () => readSettingsInternal();

// Writes are serialized: two writes at the same time would otherwise each
// read the old file and the second would silently undo the first's change.
let writeChain = Promise.resolve();
const serializeWrite = (fn) => {
  const execute = async () => { try { return await fn(); } catch (error) { invalidateCache(); throw error; } };
  const run = writeChain.then(execute, execute);
  writeChain = run.catch(() => {});
  return run;
};

export function writeSettings(patch) {
  patch = clone(patch);
  return serializeWrite(async () => {
    // Migrate an older plaintext secret before applying a replacement secret.
    // Doing this after secretSet would silently restore the old password.
    const current = await readSettingsInternal({ fresh: true, serialized: true });
    patch = { ...patch };
    if (Object.hasOwn(patch, 'language')) patch.language = 'en';
    if (Object.hasOwn(patch, 'encryptionKey')) {
      if (!sys.secretSet || typeof patch.encryptionKey !== 'string') throw new Error('Secure secret storage is unavailable');
      await sys.secretSet(patch.encryptionKey);
      delete patch.encryptionKey;
    }
    const next = { ...current, ...patch };
    await sys.writeTextAtomic(settingsFile(), JSON.stringify(next, null, 2));
    await refreshCache(next);
    return next;
  });
}

export function replaceSettings(next) {
  next = clone(next);
  return serializeWrite(async () => {
    await readSettingsInternal({ fresh: true, serialized: true });
    next = { ...next };
    next.language = 'en';
    delete next.encryptionKey; // imports never replace this machine's secret
    delete next.pluginApprovals;
    await sys.writeTextAtomic(settingsFile(), JSON.stringify(next, null, 2));
    await refreshCache(next);
    return next;
  });
}
