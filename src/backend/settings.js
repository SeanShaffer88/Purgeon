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
};

export const settingsFile = () => path.join(sys.info.dataDir, 'settings.json');

export async function readSettings() {
  try {
    const text = await sys.readText(settingsFile());
    return { ...DEFAULT_SETTINGS, ...JSON.parse(text) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function writeSettings(patch) {
  const next = { ...(await readSettings()), ...patch };
  await sys.writeText(settingsFile(), JSON.stringify(next, null, 2));
  return next;
}

export async function replaceSettings(next) {
  await sys.writeText(settingsFile(), JSON.stringify(next, null, 2));
  return next;
}
