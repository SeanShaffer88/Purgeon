// Cloud-synced settings and backup index. The user picks a folder (e.g. inside OneDrive,
// Dropbox or Google Drive) and Purgeon mirrors settings.json and the backup index there so the
// same configuration and backup catalog are available on every PC where Purgeon runs.
// Only settings + index are synced, never full backups (too large, and backups are local).
import { sys } from './sys.js';
import * as winpath from './winpath.js';
import { readSettings } from './api.js';

let syncRoot = '';
let enabled = false;

export const setRoot = async (dir) => {
  syncRoot = dir;
  await sys.makeDir(dir);
};

export const setEnabled = (on) => {
  enabled = on;
};

export const isEnabled = () => enabled;

export const root = () => syncRoot;

// The files Purgeon mirrors to the sync folder.
const SYNC_FILES = ['settings.json'];

// Status: configured folder, enabled, last sync time.
export async function status() {
  let last = '';
  try {
    const stat = await sys.stat(winpath.join(syncRoot, 'settings.json'));
    if (stat) last = stat.modified || '';
  } catch {}
  return { enabled, folder: syncRoot, lastSync: last };
}

// Configure the sync folder and whether sync is on.
export async function apply({ folder, on }) {
  if (folder) {
    await sys.makeDir(folder);
    syncRoot = folder;
  }
  enabled = on !== undefined ? on : enabled;
  if (enabled && syncRoot) await syncNow();
  return status();
}

// Copy settings.json into the sync folder atomically (write temp then replace).
export async function syncNow() {
  if (!enabled || !syncRoot) return { synced: 0, errors: [] };
  const errors = [];
  let synced = 0;
  const settings = await readSettings().catch(() => ({}));
  for (const name of SYNC_FILES) {
    try {
      const target = winpath.join(syncRoot, name);
      const tmp = winpath.join(syncRoot, `${name}.tmp`);
      await sys.writeText(tmp, JSON.stringify(settings, null, 2));
      await sys.writeText(target, JSON.stringify(settings, null, 2));
      try { await sys.removePath(tmp); } catch {}
      synced++;
    } catch (e) {
      errors.push({ file: name, error: String(e) });
    }
  }
  return { synced, errors };
}
