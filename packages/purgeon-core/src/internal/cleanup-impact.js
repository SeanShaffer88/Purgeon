import { exeOf } from './graph.js';
import { cleanDir, inside, longKey } from './safety.js';
import { isProtected } from './paths.js';
import * as path from './winpath.js';

const DETAIL_LIMIT = 200;
const MATCH_LIMIT = 6;
const REFERENCE_KIND = new Map([['service', 'services'], ['task', 'tasks'], ['run', 'startup'], ['folder', 'startup']]);
const validPath = (target) => typeof target === 'string' && /^[a-z]:\\./i.test(target);
const normalized = (target) => path.resolve(target).toLowerCase();
const label = (text) => typeof text === 'string' ? text.slice(0, 180) : '';

const isPathItem = (item) => item.kind === 'file' || item.kind === 'dir' || item.kind === 'junk';
export const hasImpactPaths = (items) => items.some(isPathItem);

const recovery = {
  file: 'Recycle Bin entry, if retained and restorable.',
  dir: 'Recycle Bin entry, if retained and restorable.',
  junk: 'Recycle Bin entry, if retained and restorable.',
  key: 'Registry export, if the backup can be saved and later imported.',
  value: 'Recorded registry value and type, if the backup can be saved.',
  createkey: 'Removal of the recreated key, subject to recovery checks.',
  setvalue: 'Recorded prior registry value or absence, if the backup can be saved.',
  service: 'Service registry export. Restoration may need administrator rights.',
  task: 'Native task definition and permissions, subject to fresh backup and grant checks.',
  firewall: 'Recorded firewall rule, if the backup can be saved and later restored.',
};

function prospectiveRecovery(item) {
  if (!item.ok || item.detail === 'Already gone' || item.detail === 'Already exists') return 'No recovery action expected for this plan result.';
  return recovery[item.kind] || 'Recovery details are unavailable for this item.';
}

function targetOf(entry) {
  const command = typeof entry.command === 'string' ? entry.command.trim() : '';
  // Task and Startup-folder targets are already separate from arguments.
  if ((entry.type === 'task' || entry.type === 'folder') && !command.startsWith('"')) return command;
  if (command.startsWith('"') || /\.(exe|com|bat|cmd|lnk)(?:\s|$)/i.test(command)) return exeOf(command);
  return '';
}

export function cleanupImpact(results, owners, ownership, integrations, pathsRequested) {
  const source = (data) => !pathsRequested ? 'not-applicable' : data ? 'observed' : 'unavailable';
  const own = new Set(owners.map(longKey));
  const programs = (ownership?.programs || []).flatMap((program) => {
    const location = cleanDir(program?.location);
    return label(program?.name) && validPath(location) && !isProtected(location) && !own.has(longKey(program.key))
      ? [{ name: label(program.name), location }] : [];
  });
  const shared = (ownership?.shared || []).filter((item) => validPath(item?.path) && Number.isInteger(item.count) && item.count > 1);
  const references = (integrations?.entries || []).flatMap((entry) => {
    const target = targetOf(entry);
    const kind = REFERENCE_KIND.get(entry.type);
    return kind && validPath(target) && label(entry.name) ? [{ kind, target, name: label(entry.name) }] : [];
  });
  const items = results.slice(0, DETAIL_LIMIT).map((item) => {
    const row = { applications: [], services: [], tasks: [], startup: [], sharedFiles: [], truncated: false, recovery: prospectiveRecovery(item) };
    if (!isPathItem(item) || !validPath(item.path)) return { ...row, pathEvidence: false };
    const directory = item.kind === 'dir' || (item.kind === 'junk' && item.dir === true);
    const matches = (target) => directory ? inside(target, item.path) : normalized(target) === normalized(item.path);
    const add = (kind, value) => {
      if (row[kind].length < MATCH_LIMIT) row[kind].push(value);
      else row.truncated = true;
    };
    for (const program of programs) {
      if (inside(item.path, program.location) || (directory && inside(program.location, item.path))) add('applications', program.name);
    }
    for (const record of shared) {
      if (matches(record.path)) add('sharedFiles', { name: label(path.basename(record.path)), users: record.count });
    }
    for (const reference of references) {
      if (matches(reference.target)) add(reference.kind, reference.name);
    }
    return { ...row, pathEvidence: true };
  });
  return {
    sources: { installed: source(ownership), shared: source(ownership), integration: integrations?.status || 'not-applicable' },
    items,
    truncated: results.length > DETAIL_LIMIT,
  };
}
