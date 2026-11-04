// Uninstall queue: programs uninstalled one after another without watching. When an uninstaller
// needs a restart, the queue is saved and Purgeon starts again after you sign in (a
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

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const validProgram = (program) => plain(program) && typeof program.key === 'string' && program.key.length > 0 && ['name', 'detail', 'status'].every((key) => program[key] === undefined || typeof program[key] === 'string');
function validateQueue(value) {
  if (!plain(value) || !Array.isArray(value.programs) || !value.programs.every(validProgram) || !Array.isArray(value.leftovers) || !value.leftovers.every(plain) || value.created !== undefined && typeof value.created !== 'string' || value.restartNeeded !== undefined && typeof value.restartNeeded !== 'boolean') throw new Error('Invalid uninstall queue schema');
  return value;
}
export async function get() {
  try { const text = await sys.readOptionalText(file); if (text === null) return null; if (typeof text !== 'string') throw new Error('Invalid optional queue read response'); let value; try { value = JSON.parse(text); } catch { throw new Error('Invalid uninstall queue JSON'); } return validateQueue(value); }
  catch (error) { throw new Error(`Uninstall queue could not be read: ${error.message}. Its file was preserved; restore access or recover it before making changes.`); }
}
let updateChain = Promise.resolve();
const update = (fn) => { const next = updateChain.then(fn, fn); updateChain = next.catch(() => {}); return next; };
const write = async (value) => { validateQueue(value); await sys.writeTextAtomic(file, JSON.stringify(value, null, 2)); return value; };
export const save = (value) => update(async () => { validateQueue(value); await get(); return write(value); });
export const clear = () => update(async () => {
  if (await get() !== null) await sys.removePath(file);
  await disarm();
});

// Adds programs to the queue (once each), after a strict read of existing evidence.
export const add = (programs) => update(async () => {
  if (!Array.isArray(programs) || !programs.every(validProgram)) throw new Error('Invalid queued programs');
  const q = (await get()) || { created: new Date().toISOString(), programs: [], leftovers: [] };
  for (const p of programs) if (!q.programs.some((x) => x.key === p.key)) q.programs.push({ ...p, status: 'pending', detail: '' });
  return write(q);
});
export const remove = (key) => update(async () => {
  const q = await get(); if (!q) return null;
  q.programs = q.programs.filter((p) => p.key !== key || p.status !== 'pending');
  return write(q);
});
// Exit codes 3010 and 1641 mean "done, restart needed" (Windows Installer and most others).
export const restartCode = (code) => code === 3010 || code === 1641;

// Whether Windows itself is waiting for a restart (component servicing or Windows Update).
export async function restartPending() {
  const out = await runPS(
    `(Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending') -or (Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired')`
  ).catch(() => 'False');
  return /True/i.test(out);
}

// Starts Purgeon once at the next sign-in to continue the queue.
export async function arm() {
  const r = await reg(['add', RUNONCE, '/v', VALUE, '/t', 'REG_SZ', '/d', `"${sys.info.exe}" --resume-queue`, '/f']);
  if (!r.ok) throw new Error(r.stderr.trim());
}
export const disarm = () => reg(['delete', RUNONCE, '/v', VALUE, '/f']).catch(() => {});

export async function restartNow() {
  await runPS(`shutdown.exe /r /t 15 /c ${psq('Purgeon: restarting to continue the uninstall queue. Save your work.')}`);
}
