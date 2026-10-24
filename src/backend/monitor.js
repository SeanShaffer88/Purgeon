// Installation monitoring: a snapshot before and after an installer runs, compared to record
// what the installation added and which existing settings it changed, so the program can be
// removed precisely later and those settings put back.
import { sys } from './sys.js';
import * as path from './winpath.js';
import { isProtected, isProtectedKey } from './paths.js';
import { capture, revertible } from './snapshots.js';

let storeDir = '';
const setRoot = async (dir) => {
  storeDir = dir;
  await sys.makeDir(path.join(storeDir, 'programs'));
};
const sessionFile = () => path.join(storeDir, 'session.json');
const beforeFile = () => path.join(storeDir, 'session-before.snap');
const afterFile = () => path.join(storeDir, 'session-after.snap');

async function start(installer) {
  const stats = await capture(beforeFile(), 'Before installation', 'standard');
  await sys.writeText(sessionFile(), JSON.stringify({ started: new Date().toISOString(), installer }));
  return { entries: stats.dirs + stats.files + stats.keys + stats.values };
}

const status = async () => {
  if (!(await sys.exists(sessionFile()))) return null;
  const { started, installer } = JSON.parse(await sys.readText(sessionFile()));
  return { started, installer };
};

const cancel = async () => {
  await sys.removePath(sessionFile());
  await sys.removePath(beforeFile());
  await sys.removePath(afterFile());
};

// Keep only top-most added paths: if a folder was added, its children are implied.
function collapse(paths) {
  const sorted = [...paths].sort((a, b) => a.length - b.length);
  const kept = [];
  const keptSet = new Set();
  for (const p of sorted) {
    const lower = p.toLowerCase();
    let parent = lower;
    let implied = false;
    while (parent.includes('\\')) {
      parent = parent.slice(0, parent.lastIndexOf('\\'));
      if (keptSet.has(parent)) {
        implied = true;
        break;
      }
    }
    if (!implied) {
      kept.push(p);
      keptSet.add(lower);
    }
  }
  return kept.sort((a, b) => a.localeCompare(b));
}

const SERVICE_KEY = /\\SYSTEM\\CurrentControlSet\\Services\\([^\\]+)$/i;

// Turns a before/after comparison into the items an uninstall of the monitored program removes or puts back.
function recordItems(comparison) {
  const items = [];
  for (const c of comparison.added) {
    if (c.kind === 'dir' || c.kind === 'file') {
      if (!isProtected(c.path)) items.push({ kind: c.kind, path: c.path, confidence: 'high', score: 100, reason: 'Created during installation' });
    } else if (c.kind === 'key') {
      const service = c.path.match(SERVICE_KEY);
      if (service) items.push({ kind: 'service', path: service[1], confidence: 'high', score: 100, reason: 'Service created during installation' });
      else if (!isProtectedKey(c.path)) items.push({ kind: 'key', path: c.path, confidence: 'high', score: 100, reason: 'Created during installation' });
    } else if (c.kind === 'value' && !SERVICE_KEY.test(c.path)) {
      items.push({ kind: 'value', path: c.path, name: c.name, confidence: 'high', score: 100, reason: 'Value added during installation' });
    }
  }
  // Settings the installer changed or removed are put back to what they were before.
  for (const c of [...comparison.changed, ...comparison.removed]) {
    if (c.kind === 'value' && revertible(c.valueType, c.before)) {
      items.push({ kind: 'setvalue', path: c.path, name: c.name, valueType: c.valueType, data: c.before, confidence: 'high', score: 90, reason: 'Changed during installation; put back the earlier value' });
    }
  }
  return items;
}

async function finish(name) {
  const session = JSON.parse(await sys.readText(sessionFile()));
  await capture(afterFile(), 'After installation', 'standard');
  const comparison = await sys.compareSnapshots(beforeFile(), afterFile(), 100000);
  const items = recordItems(comparison);
  const uninstallKeys = items.filter((k) => k.kind === 'key' && /\\CurrentVersion\\Uninstall\\[^\\]+$/i.test(k.path)).map((k) => k.path);

  const record = {
    id: `${Date.now()}`,
    name: name || path.basename(session.installer || 'Monitored program'),
    installer: session.installer,
    started: session.started,
    finished: new Date().toISOString(),
    uninstallKeys,
    items,
    changedFiles: comparison.changed.filter((c) => c.kind === 'file').length,
  };
  await sys.writeText(path.join(storeDir, 'programs', `${record.id}.json`), JSON.stringify(record, null, 2));
  await cancel();
  return record;
}

async function list() {
  const dir = path.join(storeDir, 'programs');
  const files = (await sys.readDir(dir).catch(() => [])).filter((f) => f.file && f.name.endsWith('.json'));
  const records = await Promise.all(files.map(async (f) => JSON.parse(await sys.readText(path.join(dir, f.name)))));
  return records.sort((a, b) => a.name.localeCompare(b.name));
}

const remove = (id) => sys.removePath(path.join(storeDir, 'programs', `${id}.json`));

export { setRoot, start, status, cancel, finish, list, remove, collapse, recordItems };
