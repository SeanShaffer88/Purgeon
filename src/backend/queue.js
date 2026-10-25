// Uninstall queue: programs uninstalled one after another without watching. When an uninstaller
// needs a restart, the queue is saved and SweepUninstall starts again after you sign in (a
// RunOnce entry that Windows removes after using it) to continue, then shows every leftover at once.
import { sys } from './sys.js';
import * as path from './winpath.js';
import { runPS, reg, psq } from './shell.js';

let file = '';
export const setRoot = async (dir) => {
  await sys.makeDir(dir);
  file = path.join(dir, 'queue.json');
};

const RUNONCE = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce';
const VALUE = 'SweepUninstallQueue';

export const get = () => sys.readText(file).then(JSON.parse).catch(() => null);
export const save = (q) => sys.writeText(file, JSON.stringify(q, null, 2)).then(() => q);
export async function clear() {
  await sys.removePath(file);
  await disarm();
}

// Adds programs to the queue (once each).
export async function add(programs) {
  const q = (await get()) || { created: new Date().toISOString(), programs: [], leftovers: [] };
  for (const p of programs) if (!q.programs.some((x) => x.key === p.key)) q.programs.push({ ...p, status: 'pending', detail: '' });
  return save(q);
}

export async function remove(key) {
  const q = await get();
  if (!q) return null;
  q.programs = q.programs.filter((p) => p.key !== key || p.status !== 'pending');
  return save(q);
}

// Exit codes 3010 and 1641 mean "done, restart needed" (Windows Installer and most others).
export const restartCode = (code) => code === 3010 || code === 1641;

// Whether Windows itself is waiting for a restart (component servicing or Windows Update).
export async function restartPending() {
  const out = await runPS(
    `(Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending') -or (Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired')`
  ).catch(() => 'False');
  return /True/i.test(out);
}

// Starts SweepUninstall once at the next sign-in to continue the queue.
export async function arm() {
  const r = await reg(['add', RUNONCE, '/v', VALUE, '/t', 'REG_SZ', '/d', `"${sys.info.exe}" --resume-queue`, '/f']);
  if (!r.ok) throw new Error(r.stderr.trim());
}
export const disarm = () => reg(['delete', RUNONCE, '/v', VALUE, '/f']).catch(() => {});

export async function restartNow() {
  await runPS(`shutdown.exe /r /t 15 /c ${psq('SweepUninstall: restarting to continue the uninstall queue. Save your work.')}`);
}
