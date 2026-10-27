// Command log: one line for every command Purgeon runs (PowerShell scripts, programs
// such as reg.exe and sc.exe, uninstallers, Recycle Bin moves), with the time, how long it
// took and whether it worked. One file per day in the logs folder, kept for 14 days.
import { sys } from './sys.js';
import * as path from './winpath.js';

const KEEP_DAYS = 14;
let dir = '';
let pending = [];
let timer = null;

export const folder = () => dir;
const day = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const clock = (d) => `${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, '0')}`;

export async function setRoot(d) {
  dir = d;
  await sys.makeDir(dir);
  const cutoff = Date.now() - KEEP_DAYS * 86400000;
  for (const f of await sys.readDir(dir).catch(() => [])) {
    const m = f.name.match(/^(\d{4})-(\d{2})-(\d{2})\.log$/);
    if (m && new Date(+m[1], +m[2] - 1, +m[3]).getTime() < cutoff) await sys.removePath(path.join(dir, f.name));
  }
}

// Writes out whatever lines are waiting; shared by the timer flush and flushNow.
async function flushPending() {
  if (!pending.length || !dir) return;
  const text = pending.join('');
  pending = [];
  await sys.appendText(path.join(dir, `${day()}.log`), text).catch(() => {});
}

function flush() {
  timer = null;
  flushPending();
}

// Flushes immediately and waits for the write, so quitting does not lose the
// last fraction of a second of log lines still waiting on the timer.
export async function flushNow() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  await flushPending();
}

// A short, single-line description of a call.
export function describe(name, args) {
  const oneLine = (s, n = 200) => String(s).replace(/\s+/g, ' ').trim().slice(0, n);
  if (name === 'runPS') return `PowerShell: ${oneLine(args[0])}${args[1] ? ` [input ${String(args[1]).length} chars]` : ''}`;
  if (name === 'exec' || name === 'launch') return `${args[0]} ${(args[1] || []).map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`;
  if (name === 'runCommandLine') return `Uninstall command: ${oneLine(args[0])}`;
  if (name === 'trash') return `Move to Recycle Bin: ${args[0]}`;
  if (name === 'trashMany') return `Move ${args[0].length} items to Recycle Bin`;
  if (name === 'trackLaunch') return `Start tracked installer: ${args[0]}`;
  return `${name}`;
}

export function write(line) {
  const now = new Date();
  pending.push(`${clock(now)}  ${line}\r\n`);
  if (!timer) timer = setTimeout(flush, 500);
}

// Wraps the system layer's command-running functions so each call is logged.
export function wrap(target) {
  for (const name of ['runPS', 'exec', 'runCommandLine', 'launch', 'trash', 'trashMany', 'trackLaunch']) {
    const original = target[name];
    if (typeof original !== 'function' || original.logged) continue;
    const wrapped = async (...args) => {
      const t0 = Date.now();
      try {
        const result = await original(...args);
        const failed = result && typeof result === 'object' && 'ok' in result && !result.ok;
        write(`${failed ? 'FAIL' : 'ok  '}  ${String(Date.now() - t0).padStart(6)}ms  ${describe(name, args)}${failed ? `  -> exit ${result.code}` : ''}`);
        return result;
      } catch (e) {
        write(`FAIL  ${String(Date.now() - t0).padStart(6)}ms  ${describe(name, args)}  -> ${String(e?.message || e).replace(/\s+/g, ' ').slice(0, 200)}`);
        throw e;
      }
    };
    wrapped.logged = true;
    target[name] = wrapped;
  }
}
