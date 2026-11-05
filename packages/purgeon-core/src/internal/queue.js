// Uninstall queue: programs uninstalled one after another without watching. When an uninstaller
// needs a restart, the queue is saved and Purgeon starts again after you sign in (a
// RunOnce entry that Windows removes after using it) to continue, then shows every leftover at once.
import { sys } from './sys.js';
import * as path from './winpath.js';
import { runPS, reg, psq } from './shell.js';

let file = '';
let resumeAvailable = false;
export const setRoot = async (dir) => {
  await sys.makeDir(dir);
  file = path.join(dir, 'queue.json');
  resumeAvailable = Array.isArray(sys.info?.launch) && sys.info.launch.some(arg => typeof arg === 'string' && arg.toLowerCase() === '--resume-queue');
};

const RUNONCE = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce';
const VALUE = 'SweepUninstallQueue';

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const validProgram = (program) => plain(program) && typeof program.key === 'string' && program.key.length > 0 && ['name', 'detail', 'status'].every((key) => program[key] === undefined || typeof program[key] === 'string');
const tokenPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const validToken = (value) => typeof value === 'string' && tokenPattern.test(value);
const revision = (q) => q === null ? null : q.revision ?? 0;
const pendingReview = 'The uninstall queue has an interrupted or unfinished item. Review it before making queue changes.';
const restartRequired = 'The uninstall queue is waiting for Windows to restart.';
const staleQueue = 'The uninstall queue changed. Reopen it and review the current items.';
const phaseOf = (intent) => intent.outcome ? 'cleanupPending' : 'launching';
let activeAttempt = null;

function validateIntent(q) {
  const intent = q.intent;
  const unfinished = q.programs.filter(p => ['launching', 'cleanupPending'].includes(p.status));
  if (intent === undefined) return unfinished.length === 0;
  if (!plain(intent) || !validToken(intent.token) || typeof intent.key !== 'string' ||
      !Array.isArray(intent.installerItems) || !intent.installerItems.every(plain)) return false;
  const outcome = intent.outcome;
  if (outcome !== undefined && (!plain(outcome) || !['done', 'failed', 'skipped'].includes(outcome.status) ||
      typeof outcome.detail !== 'string' || typeof outcome.restartNeeded !== 'boolean')) return false;
  return unfinished.length === 1 && unfinished[0].key === intent.key &&
    q.programs.filter(p => p.key === intent.key).length === 1 && unfinished[0].status === phaseOf(intent);
}

function validateQueue(value) {
  if (!plain(value) || !Array.isArray(value.programs) || !value.programs.every(validProgram) || !Array.isArray(value.leftovers) || !value.leftovers.every(plain) || value.created !== undefined && typeof value.created !== 'string' || value.restartNeeded !== undefined && typeof value.restartNeeded !== 'boolean') throw new Error('Invalid uninstall queue schema');
  if ((value.revision !== undefined && !validToken(value.revision)) ||
      (value.restartToken !== undefined && (!validToken(value.restartToken) || value.restartNeeded !== true)) ||
      !validateIntent(value)) throw new Error('Invalid uninstall queue intent or revision');
  return value;
}
export async function get() {
  try { const text = await sys.readOptionalText(file); if (text === null) return null; if (typeof text !== 'string') throw new Error('Invalid optional queue read response'); let value; try { value = JSON.parse(text); } catch { throw new Error('Invalid uninstall queue JSON'); } return validateQueue(value); }
  catch (error) { throw new Error(`Uninstall queue could not be read: ${error.message}. Its file was preserved; restore access or recover it before making changes.`); }
}
let updateChain = Promise.resolve();
const update = (fn) => { const next = updateChain.then(fn, fn); updateChain = next.catch(() => {}); return next; };
const write = async (value) => {
  const next = validateQueue({ ...value, revision: globalThis.crypto.randomUUID() });
  await sys.writeTextAtomic(file, JSON.stringify(next, null, 2));
  return next;
};
function assertIdle(q) {
  if (q?.intent) throw new Error(pendingReview);
  if (q?.restartNeeded) throw new Error(restartRequired);
}
export const save = (value) => update(async () => {
  validateQueue(value);
  const current = await get();
  assertIdle(current);
  assertIdle(value);
  if (revision(current) !== revision(value)) throw new Error(staleQueue);
  return write(value);
});
export const clear = () => update(async () => {
  const q = await get();
  assertIdle(q);
  if (q !== null) await sys.removePath(file);
  await disarm();
});

// Adds programs to the queue (once each), after a strict read of existing evidence.
export const add = (programs) => update(async () => {
  if (!Array.isArray(programs) || !programs.every(validProgram)) throw new Error('Invalid queued programs');
  const q = (await get()) || { created: new Date().toISOString(), programs: [], leftovers: [] };
  assertIdle(q);
  for (const p of programs) if (!q.programs.some((x) => x.key === p.key)) q.programs.push({ ...p, status: 'pending', detail: '' });
  return write(q);
});
export const remove = (key) => update(async () => {
  const q = await get(); if (!q) return null;
  assertIdle(q);
  q.programs = q.programs.filter((p) => p.key !== key || p.status !== 'pending');
  return write(q);
});

function requireIntent(q, token, phase) {
  if (!validToken(token) || q?.intent?.token !== token || phaseOf(q.intent) !== phase) throw new Error(staleQueue);
  return q.programs.find(p => p.key === q.intent.key);
}

export async function runStep(request, launch) {
  if (!plain(request) || typeof request.key !== 'string' ||
      !Array.isArray(request.installerItems) || !request.installerItems.every(plain)) throw new Error('Invalid queue launch request');
  const { key, revision: expected, installerItems } = structuredClone(request);
  let token;
  try {
    const program = await update(async () => {
      const q = await get();
      assertIdle(q);
      if (revision(q) !== expected || !q) throw new Error(staleQueue);
      const matches = q.programs.filter(p => p.key === key);
      if (matches.length !== 1 || matches[0].status !== 'pending' || matches[0].store) throw new Error(staleQueue);
      const p = matches[0];
      token = globalThis.crypto.randomUUID();
      q.intent = { token, key, installerItems };
      p.status = 'launching';
      await write(q);
      activeAttempt = token;
      return p;
    });
    // A rejection or unconfirmed result preserves the intent and prevents replay.
    const result = await launch(program);
    if (!plain(result) || typeof result.ok !== 'boolean' || result.code === -1 || result.uncertain) throw new Error(pendingReview);
    const needsRestart = restartCode(result.code) || await restartPending();
    return await update(async () => {
      const q = await get();
      const p = requireIntent(q, token, 'launching');
      const status = result.ok || restartCode(result.code) ? 'done' : 'failed';
      const detail = typeof result.error === 'string' ? result.error : status === 'done' ? '' : `exit code ${result.code ?? 'unknown'}`;
      q.intent.outcome = { status, detail, restartNeeded: needsRestart };
      p.status = 'cleanupPending';
      if (needsRestart) {
        q.restartNeeded = true;
        q.restartToken = token;
      }
      return write(q);
    });
  } finally {
    if (activeAttempt === token) activeAttempt = null;
  }
}

export const reviewInterrupted = (token) => update(async () => {
  const q = await get();
  const p = requireIntent(q, token, 'launching');
  if (activeAttempt === token) throw new Error('The queued uninstaller is still running.');
  q.intent.outcome = { status: 'skipped', detail: 'The interrupted uninstall was reviewed without retrying.', restartNeeded: false };
  p.status = 'cleanupPending';
  return write(q);
});

export async function scanStep(token, scan) {
  const q = await get();
  const program = requireIntent(q, token, 'cleanupPending');
  const items = await scan({ ...program, installerItems: q.intent.installerItems });
  if (!Array.isArray(items) || !items.every(plain)) throw new Error('The leftover scan did not complete. Retry the scan from the queue.');
  return update(async () => {
    const current = await get();
    const p = requireIntent(current, token, 'cleanupPending');
    const { status, detail } = current.intent.outcome;
    p.status = status;
    p.detail = detail;
    current.leftovers.push(...items.map((item, i) => ({ ...item, program: p.name, queueLeftoverId: `${token}:${i}` })));
    delete current.intent;
    return write(current);
  });
}

export const acknowledgeRestart = (token) => update(async () => {
  if (!resumeAvailable) throw new Error('Queue restart acknowledgement requires the sign-in resume request.');
  const q = await get();
  if (!q?.restartNeeded) {
    resumeAvailable = false;
    return q;
  }
  if ((q.restartToken ?? null) !== token) throw new Error(staleQueue);
  q.restartNeeded = false;
  delete q.restartToken;
  if (q.intent?.outcome) q.intent.outcome.restartNeeded = false;
  const next = await write(q);
  resumeAvailable = false;
  return next;
});

export const armRestart = (token) => update(async () => {
  const q = await get();
  if (!q?.restartNeeded || (q.restartToken ?? null) !== token) throw new Error(staleQueue);
  await arm();
});

// Remove only a selected occurrence proven successful by the backup operation.
// Compare the full payload because registry values and native items may share paths.
const itemBytes = item => JSON.stringify(item);
function reportedItem(item) {
  const copy = { ...item };
  delete copy.ok;
  delete copy.detail;
  return itemBytes(copy);
}
function takeMatch(items, match) {
  const i = items.findIndex(match);
  return i === -1 ? null : items.splice(i, 1)[0];
}

export async function removeLeftovers(request, removeSelected) {
  if (!plain(request) || !Array.isArray(request.items) || !request.items.every(plain)) throw new Error('Invalid queue leftover selection');
  const { items, revision: expected } = structuredClone(request);
  const before = await get();
  assertIdle(before);
  if (!before || revision(before) !== expected || before.programs.some(p => p.status === 'pending')) throw new Error(staleQueue);
  const available = [...before.leftovers];
  const selected = items.map(item => takeMatch(available, candidate => itemBytes(candidate) === itemBytes(item)));
  if (selected.some(item => !item)) throw new Error(staleQueue);
  const result = await removeSelected(selected, before.programs.map(p => p.key));
  if (!Array.isArray(result?.results) || result.interrupted || result.recoveryRequired) return result;
  const matched = [...selected];
  const proven = result.results.filter(item => item?.ok === true && !item.uncertain)
    .map(item => takeMatch(matched, candidate => reportedItem(candidate) === reportedItem(item))).filter(Boolean);
  if (!proven.length) return result;
  try {
    await update(async () => {
      const current = await get();
      if (revision(current) !== expected) throw new Error(staleQueue);
      assertIdle(current);
      const remaining = [...proven];
      current.leftovers = current.leftovers.filter(item => !takeMatch(remaining, candidate => itemBytes(candidate) === itemBytes(item)));
      if (remaining.length === proven.length) return;
      if (!current.leftovers.length) {
        await sys.removePath(file);
        await disarm();
      } else {
        await write(current);
      }
    });
  } catch {
    return { ...result, queueRetirementUnconfirmed: true };
  }
  return result;
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

// Starts Purgeon once at the next sign-in to continue the queue.
export async function arm() {
  const r = await reg(['add', RUNONCE, '/v', VALUE, '/t', 'REG_SZ', '/d', `"${sys.info.exe}" --resume-queue`, '/f']);
  if (!r.ok) throw new Error(r.stderr.trim());
}
export const disarm = () => reg(['delete', RUNONCE, '/v', VALUE, '/f']).catch(() => {});

export async function restartNow() {
  await runPS(`shutdown.exe /r /t 15 /c ${psq('Purgeon: restarting to continue the uninstall queue. Save your work.')}`);
}
