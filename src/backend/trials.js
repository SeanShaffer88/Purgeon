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

const read = () => sys.readText(file).then(JSON.parse).catch(() => []);
const write = (l) => sys.writeTextAtomic(file, JSON.stringify(l, null, 2));

export const list = read;

export async function start(installer, name) {
  const meta = await snapshots.take(`Trial: ${name}`, 'standard');
  const trial = { id: `${Date.now()}`, name, installer, snapshotId: meta.id, started: new Date().toISOString() };
  await write([...(await read()), trial]);
  return trial;
}

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
  const items = await snapshots.cleanupItems(t.snapshotId, selected);
  return { trial: t, items, added: cmp.added.length, changed: cmp.changed.length, removed: cmp.removed.length, truncated: cmp.truncated };
}

// Ends a trial (after Try Over or to keep the program); its snapshot is deleted.
export async function finish(id) {
  const all = await read();
  const t = all.find((x) => x.id === id);
  if (t) await snapshots.remove(t.snapshotId).catch(() => {});
  await write(all.filter((x) => x.id !== id));
}
