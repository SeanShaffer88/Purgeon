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
  detectInstallers: false,
  startupMonitoring: false,
  resourceAlerts: false,
  recordSizeHistory: false,
  alertThresholds: { cpu: 90, mem: 90, diskFreeGB: 20 },
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
  let text;
  try {
    text = await sys.readText(settingsFile());
  } catch {
    value = { ...DEFAULT_SETTINGS };
  }
  if (text !== undefined) {
    try {
      value = { ...DEFAULT_SETTINGS, ...JSON.parse(text), language: 'en' };
    } catch {
      // The file is damaged (a crash mid-write used to do this; writes are
      // atomic now, but older damage can still be on disk). Keep a copy of the
      // damaged text, record it so the user is told, and start from defaults
      // written back cleanly — never silently throw the user's settings away.
      await datadamage.quarantine(settingsFile(), text).catch(() => {});
      value = { ...DEFAULT_SETTINGS };
      await sys.writeTextAtomic(settingsFile(), JSON.stringify(value, null, 2)).catch(() => {});
      cachedValue = value;
      cachedMtime = await statMtime();
      return { ...value };
    }
  }
  // Migrate legacy plaintext once, before returning/exporting any settings.
  if (typeof value?.encryptionKey === 'string' && value.encryptionKey) {
    if (!sys.secretSet) throw new Error('Secure secret storage is unavailable; settings migration stopped');
    await sys.secretSet(value.encryptionKey);
    delete value.encryptionKey;
    await sys.writeTextAtomic(settingsFile(), JSON.stringify(value, null, 2));
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
    // Migrate an older plaintext secret before applying a replacement secret.
    // Doing this after secretSet would silently restore the old password.
    const current = await readSettings();
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
  return serializeWrite(async () => {
    next = { ...next };
    next.language = 'en';
    delete next.encryptionKey; // imports never replace this machine's secret
    delete next.pluginApprovals;
    await sys.writeTextAtomic(settingsFile(), JSON.stringify(next, null, 2));
    await refreshCache(next);
    return next;
  });
}
