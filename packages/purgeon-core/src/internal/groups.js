// Program groups: names the user gives programs ("Games", "Work tools"...) to filter the list.
// Stored as { programKey: groupName } in groups.json.
import { sys } from './sys.js';
import * as path from './winpath.js';
import * as datadamage from './datadamage.js';

let file = '';
export const setRoot = async (dir) => {
  await sys.makeDir(dir);
  file = path.join(dir, 'groups.json');
};

export const get = async () => {
  let text;
  try {
    text = await sys.readText(file);
  } catch {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    // Damaged file: keep a copy of the text, record it so the user is told,
    // and start from an empty set written back cleanly (see datadamage.js).
    await datadamage.quarantine(file, text).catch(() => {});
    await sys.writeTextAtomic(file, '{}').catch(() => {});
    return {};
  }
};

// Puts programs in a group ('' takes them out). Returns each program's previous group, for undo.
export async function set(keys, group) {
  const all = await get();
  // Leading control characters are stripped: the built-in groups are marked
  // with one, and a typed name must never be able to impersonate them.
  const name = String(group || '').replace(/^[\u0000-\u001f]+/, '').trim().slice(0, 60);
  const previous = Object.fromEntries(keys.map((k) => [k, all[k] || '']));
  for (const k of keys) {
    if (name) all[k] = name;
    else delete all[k];
  }
  await sys.writeTextAtomic(file, JSON.stringify(all, null, 2));
  return previous;
}

// Puts each program back in the group it had before ({ key: group }).
export async function restore(previous) {
  const all = await get();
  for (const [k, g] of Object.entries(previous)) {
    if (g) all[k] = g;
    else delete all[k];
  }
  await sys.writeTextAtomic(file, JSON.stringify(all, null, 2));
  return previous;
}

export const names = (all) => [...new Set(Object.values(all))].sort((a, b) => a.localeCompare(b));
