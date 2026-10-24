// Program groups: names the user gives programs ("Games", "Work tools"...) to filter the list.
// Stored as { programKey: groupName } in groups.json.
import { sys } from './sys.js';
import * as path from './winpath.js';

let file = '';
export const setRoot = async (dir) => {
  await sys.makeDir(dir);
  file = path.join(dir, 'groups.json');
};

export const get = () =>
  sys
    .readText(file)
    .then(JSON.parse)
    .catch(() => ({}));

// Puts programs in a group ('' takes them out). Returns each program's previous group, for undo.
export async function set(keys, group) {
  const all = await get();
  const name = String(group || '').trim().slice(0, 60);
  const previous = Object.fromEntries(keys.map((k) => [k, all[k] || '']));
  for (const k of keys) {
    if (name) all[k] = name;
    else delete all[k];
  }
  await sys.writeText(file, JSON.stringify(all, null, 2));
  return previous;
}

// Puts each program back in the group it had before ({ key: group }).
export async function restore(previous) {
  const all = await get();
  for (const [k, g] of Object.entries(previous)) {
    if (g) all[k] = g;
    else delete all[k];
  }
  await sys.writeText(file, JSON.stringify(all, null, 2));
  return previous;
}

export const names = (all) => [...new Set(Object.values(all))].sort((a, b) => a.localeCompare(b));
