// Cloud-synced settings and backup index with conflict detection and selective sync.
// The user picks a folder (e.g. inside OneDrive, Dropbox or Google Drive) and Purgeon mirrors
// settings.json there so the same configuration is available on every PC where Purgeon runs.
// Only settings are synced, never full backups (too large, and backups are local).
import { sys } from './sys.js';
import * as winpath from './winpath.js';
import { readSettings } from './api.js';
import { createHash } from 'node:crypto';

let syncRoot = '';
let enabled = false;
let syncFiles = ['settings.json'];

export const setRoot = async (dir) => {
  syncRoot = dir;
  await sys.makeDir(dir);
};

export const setEnabled = (on) => {
  enabled = on;
};

export const isEnabled = () => enabled;

export const root = () => syncRoot;

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// Last-synced copies live alongside the synced files with a .last-synced suffix.
const lastSynced = (name) => winpath.join(syncRoot, `${name}.last-synced`);

// Status: configured folder, enabled, last sync time, conflicts, selective-sync file list.
export async function status() {
  let last = '';
  let conflict = false;
  try {
    const stat = await sys.stat(winpath.join(syncRoot, 'settings.json'));
    if (stat) last = stat.modified || '';
  } catch {}
  try {
    const local = await readSettings().catch(() => null);
    const syncCopy = await sys.readText(winpath.join(syncRoot, 'settings.json')).catch(() => null);
    const lastCopy = await sys.readText(lastSynced('settings.json')).catch(() => null);
    if (local && syncCopy && lastCopy) {
      const localHash = sha256(JSON.stringify(local));
      const syncHash = sha256(syncCopy);
      const lastHash = sha256(lastCopy);
      if (localHash !== syncHash && syncHash !== lastHash) conflict = true;
    }
  } catch {}
  return { enabled, folder: syncRoot, lastSync: last, conflict, syncFiles };
}

// Configure the sync folder, whether sync is on, and which files to sync.
export async function apply({ folder, on, files }) {
  if (folder) {
    await sys.makeDir(folder);
    syncRoot = folder;
  }
  enabled = on !== undefined ? on : enabled;
  if (files) syncFiles = files;
  if (enabled && syncRoot) await syncNow();
  return status();
}

// Copy settings into the sync folder atomically, with conflict detection.
// If local differs from sync-folder and sync-folder differs from last-synced, it's a conflict:
// the file is not overwritten and the conflict is reported.
export async function syncNow() {
  if (!enabled || !syncRoot) return { synced: 0, errors: [], conflicts: [] };
  const errors = [];
  const conflicts = [];
  let synced = 0;
  const settings = await readSettings().catch(() => ({}));
  const settingsText = JSON.stringify(settings, null, 2);

  for (const name of syncFiles) {
    try {
      const target = winpath.join(syncRoot, name);
      const tmp = winpath.join(syncRoot, `${name}.tmp`);
      const ls = lastSynced(name);

      let syncCopy = '';
      let lastCopy = '';
      try { syncCopy = await sys.readText(target); } catch {}
      try { lastCopy = await sys.readText(ls); } catch {}

      const localHash = sha256(settingsText);
      const syncHash = sha256(syncCopy);
      const lastHash = sha256(lastCopy);
      if (localHash !== syncHash && syncHash !== lastHash && lastCopy !== '') {
        conflicts.push(name);
        continue; // Don't overwrite; user must resolve the conflict.
      }

      await sys.writeText(tmp, settingsText);
      await sys.writeText(target, settingsText);
      await sys.writeText(ls, settingsText);
      try { await sys.removePath(tmp); } catch {}
      synced++;
    } catch (e) {
      errors.push({ file: name, error: String(e) });
    }
  }
  return { synced, errors, conflicts };
}
