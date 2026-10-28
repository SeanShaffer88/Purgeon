// Centralized settings I/O so multiple modules don't each re-implement it.
// Also breaks the circular import cycle: trusted.js/updatecheck.js/sync.js
// previously imported readSettings from api.js, which imported them back.
import { sys } from './sys.js';
import * as path from './winpath.js';

export const DEFAULT_SETTINGS = {
  createRestorePoints: true,
  silentUninstall: false,
  safeMode: false,
  backupMaxDays: 0,
  backupMaxMB: 0,
  gridLines: true,
  requireSignature: false,
  encryptionKey: '',
  disabledConfirmations: [],
  textScale: 1,
  reducedMotion: false,
};

export const settingsFile = () => path.join(sys.info.dataDir, 'settings.json');

// Settings are read by many backend calls, so the parsed file is cached and only
// re-read when the file's modified time changes; edits made outside the app are
// still picked up, and the app's own writes refresh the cache directly.
let cachedValue = null;
let cachedMtime = null;

const statMtime = async () => {
  try {
    const s = await sys.stat(settingsFile());
    return s ? s.modified : null;
  } catch {
    return null;
  }
};

export async function readSettings() {
  const mtime = await statMtime();
  // No settings file: the defaults, deliberately not cached (the file may appear).
  if (mtime === null) return { ...DEFAULT_SETTINGS };
  if (cachedValue && cachedMtime === mtime) return { ...cachedValue };
  let value;
  try {
    const text = await sys.readText(settingsFile());
    value = { ...DEFAULT_SETTINGS, ...JSON.parse(text) };
  } catch {
    value = { ...DEFAULT_SETTINGS };
  }
  cachedValue = value;
  cachedMtime = mtime;
  return { ...value };
}

// After one of the app's own writes, point the cache at what was written, keyed
// to the file's new modified time; if the file cannot be stat'ed, drop the cache.
async function refreshCache(next) {
  const mtime = await statMtime();
  if (mtime === null) {
    cachedValue = null;
    cachedMtime = null;
  } else {
    cachedValue = { ...DEFAULT_SETTINGS, ...next };
    cachedMtime = mtime;
  }
}

// Writes are serialized: two writes at the same time would otherwise each
// read the old file and the second would silently undo the first's change.
let writeChain = Promise.resolve();
const serializeWrite = (fn) => {
  const run = writeChain.then(fn, fn);
  writeChain = run.catch(() => {});
  return run;
};

export function writeSettings(patch) {
  return serializeWrite(async () => {
    const next = { ...(await readSettings()), ...patch };
    await sys.writeText(settingsFile(), JSON.stringify(next, null, 2));
    await refreshCache(next);
    return next;
  });
}

export function replaceSettings(next) {
  return serializeWrite(async () => {
    await sys.writeText(settingsFile(), JSON.stringify(next, null, 2));
    await refreshCache(next);
    return next;
  });
}
