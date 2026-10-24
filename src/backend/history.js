// Change History: every change SweepUninstall makes, newest first, each with how to undo it.
// An entry's `undo` is a request ({ channel, arg }) that reverses the change, or null when the
// change can't be undone directly (an uninstaller run; a restore point covers that).
import { sys } from './sys.js';
import * as path from './winpath.js';

const LIMIT = 500;
let file = '';
let queue = Promise.resolve();

export const setRoot = async (dir) => {
  await sys.makeDir(dir);
  file = path.join(dir, 'history.json');
};

export const list = () => (file ? sys.readText(file).then(JSON.parse).catch(() => []) : Promise.resolve([]));

// Writes go one at a time so quick successive changes are all kept.
const update = (fn) => {
  queue = queue.then(async () => {
    if (!file) return;
    const entries = fn(await list());
    await sys.writeText(file, JSON.stringify(entries.slice(0, LIMIT), null, 2));
  });
  return queue;
};

let counter = 0;
export function record({ type, title, detail = '', undo = null }) {
  const entry = { id: `${Date.now()}-${++counter}`, time: new Date().toISOString(), type, title, detail, undo, undone: false };
  return update((entries) => [entry, ...entries]).then(() => entry);
}

export const markUndone = (id) => update((entries) => entries.map((e) => (e.id === id ? { ...e, undone: true, undoneAt: new Date().toISOString() } : e)));
