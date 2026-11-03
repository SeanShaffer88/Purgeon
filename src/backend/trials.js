// Trial installs: a snapshot is taken before installing, you use the program, and "Try Over"
// removes everything added since then (the installation and whatever the program created
// while you tried it) and puts changed settings back, as if it was never installed.
import { sys } from './sys.js';
import * as path from './winpath.js';
import * as snapshots from './snapshots.js';

let file = '';
export const setRoot = async (dir) => {
  await sys.makeDir(dir);
  file = path.join(dir, 'trials.json');
};

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const reference = (value) => typeof value === 'string' && value.length > 0;
function validateTrials(value) {
  if (!Array.isArray(value) || !value.every((trial) => plain(trial) && reference(trial.id) && reference(trial.snapshotId) && ['name', 'started'].every((key) => trial[key] === undefined || typeof trial[key] === 'string') && (trial.installer === undefined || trial.installer === null || typeof trial.installer === 'string'))) throw new Error('Invalid trial records schema');
  return value;
}
async function read() {
  try { const text = await sys.readOptionalText(file); if (text === null) return []; if (typeof text !== 'string') throw new Error('Invalid optional trial read response'); let value; try { value = JSON.parse(text); } catch { throw new Error('Invalid trial records JSON'); } return validateTrials(value); }
  catch (error) { throw new Error(`Trial records could not be read: ${error.message}. Their file and snapshot references were preserved; restore access or recover them before making changes.`); }
}
const write = (value) => { validateTrials(value); return sys.writeTextAtomic(file, JSON.stringify(value, null, 2)); };
let updateChain = Promise.resolve();
const update = (fn) => { const next = updateChain.then(fn, fn); updateChain = next.catch(() => {}); return next; };
export const list = read;
export const start = (installer, name) => update(async () => {
  if (name !== undefined && typeof name !== 'string' || installer !== undefined && installer !== null && typeof installer !== 'string') throw new Error('Invalid trial details');
  const existing = await read(); // No snapshot is created until existing records are readable.
  const meta = await snapshots.take(`Trial: ${name}`, 'standard');
  if (meta?.cancelled) return { cancelled: true };
  if (!reference(meta?.id)) throw new Error('Trial snapshot did not return a valid reference; trial records were left unchanged');
  const trial = { id: `${Date.now()}`, name, installer, snapshotId: meta.id, started: new Date().toISOString() };
  await write([...existing, trial]); return trial;
});
// Everything that changed since the trial started, as clean-up items, plus the counts.
export async function tryOver(id) {
  const t = (await read()).find((x) => x.id === id);
  if (!t) throw new Error('That trial no longer exists.');
  const cmp = await snapshots.compare(t.snapshotId, 'now', 100000);
  const selected = [
    ...cmp.added.map((c) => ({ ...c, group: 'added' })),
    ...cmp.changed.filter((c) => c.kind === 'value').map((c) => ({ ...c, group: 'changed' })),
    ...cmp.removed.filter((c) => c.kind === 'value' || c.kind === 'key').map((c) => ({ ...c, group: 'removed' })),
  ];
  const items = (await snapshots.cleanupItems(t.snapshotId, selected)).map((item) => ({ ...item, source: 'snapshot', evidence: 'Unattributed snapshot difference', score: 35, confidence: 'low', reason: 'Changed during the trial window; may belong to another application. Review before selecting.' }));
  return { trial: t, items, added: cmp.added.length, changed: cmp.changed.length, removed: cmp.removed.length, truncated: cmp.truncated };
}

// Ends a trial (after Try Over or to keep the program); its snapshot is deleted.
export const finish = (id) => update(async () => {
  const all = await read();
  const trial = all.find((entry) => entry.id === id);
  await write(all.filter((entry) => entry.id !== id));
  // A failed list save preserves both reference and snapshot. After a successful
  // save, cleanup remains best effort; an orphan is safer than a lost reference.
  if (trial) await snapshots.remove(trial.snapshotId).catch(() => {});
});
