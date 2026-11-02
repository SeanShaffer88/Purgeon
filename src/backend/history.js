// Change History: every change Purgeon makes, newest first, each with how to undo it.
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

const validEntry = (entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
  && (typeof entry.id === 'string' || typeof entry.id === 'number') && typeof entry.time === 'string' && Number.isFinite(Date.parse(entry.time))
  && typeof entry.type === 'string' && typeof entry.title === 'string' && typeof entry.detail === 'string'
  && (entry.undone === undefined || typeof entry.undone === 'boolean')
  && (entry.undo == null || typeof entry.undo === 'object' && !Array.isArray(entry.undo) && typeof entry.undo.channel === 'string');
export async function list() {
  if (!file) return [];
  try {
    const text = await sys.readOptionalText(file);
    if (text === null) return [];
    const entries = JSON.parse(text);
    if (!Array.isArray(entries) || !entries.every(validEntry)) throw new Error('invalid history schema');
    return entries;
  } catch (error) {
    throw new Error(`Change History could not be read: ${error.message}. Its existing file was preserved. Restore access or recover the history file before recording further changes.`);
  }
}

// Writes go one at a time so quick successive changes are all kept.
const update = (fn) => {
  queue = queue.catch(() => {}).then(async () => {
    if (!file) return;
    const entries = fn(await list());
    await sys.writeTextAtomic(file, JSON.stringify(entries.slice(0, LIMIT), null, 2));
  });
  return queue;
};

let counter = 0;
export function record({ type, title, detail = '', undo = null }) {
  const entry = { id: `${Date.now()}-${++counter}`, time: new Date().toISOString(), type, title, detail, undo, undone: false };
  return update((entries) => [entry, ...entries]).then(() => entry);
}

export const markUndone = (id) => update((entries) => entries.map((e) => (e.id === id ? { ...e, undone: true, undoneAt: new Date().toISOString() } : e)));
