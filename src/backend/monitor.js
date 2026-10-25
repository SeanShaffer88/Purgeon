// Installation monitoring: a snapshot before and after an installer runs, compared to record
// what the installation added and which existing settings it changed, so the program can be
// removed precisely later and those settings put back.
// With administrator rights, the installer is also tracked live (see src-tauri/src/tracker.rs):
// every file and registry change made by it and the processes it starts is recorded as it
// happens, at any depth, and added to what the snapshots found.
import { sys } from './sys.js';
import * as path from './winpath.js';
import { runPS } from './shell.js';
import { isProtected, isProtectedKey } from './paths.js';
import { capture, revertible } from './snapshots.js';
import { stillPresent } from './installers.js';

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
  // Live tracking only follows an installer Purgeon starts itself.
  const live = !!installer && !!sys.trackStart && (await sys.trackStart().then(() => true, () => false));
  await sys.writeText(sessionFile(), JSON.stringify({ started: new Date().toISOString(), installer, live }));
  return { entries: stats.dirs + stats.files + stats.keys + stats.values, live };
}

// Monitoring for an installer that is already running (spotted by installwatch.js): the "before"
// snapshot is taken now, while it waits on its first page. Snapshots only, no live tracking.
async function attach(installer, name) {
  const stats = await capture(beforeFile(), 'Before installation', 'standard');
  await sys.writeText(sessionFile(), JSON.stringify({ started: new Date().toISOString(), installer, name, live: false, attached: true }));
  return { entries: stats.dirs + stats.files + stats.keys + stats.values };
}

// Starts the installer: as a tracked child process when live tracking runs, otherwise through Explorer.
async function launch(installer, open) {
  if (sys.trackRunning && (await sys.trackRunning())) return sys.trackLaunch(installer);
  return open(installer);
}

const status = async () => {
  if (!(await sys.exists(sessionFile()))) return null;
  const { started, installer, name, attached } = JSON.parse(await sys.readText(sessionFile()));
  // A trace does not survive Purgeon closing, so a resumed session has snapshots only.
  const live = !!sys.trackRunning && (await sys.trackRunning());
  return { started, installer, name, attached: !!attached, live };
};

const cancel = async () => {
  if (sys.trackRunning && (await sys.trackRunning())) await sys.trackStop().catch(() => {});
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
  const tracked = sys.trackRunning && (await sys.trackRunning()) ? await sys.trackStop().catch(() => null) : null;
  await capture(afterFile(), 'After installation', 'standard');
  const comparison = await sys.compareSnapshots(beforeFile(), afterFile(), 100000);
  let items = recordItems(comparison);
  if (tracked) {
    const sid = (await runPS('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value').catch(() => '')).trim();
    const live = await stillPresent(liveItems(tracked, sid, path.basename(session.installer || 'the installer')));
    items = mergeItems(items, live);
  }
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
    ...(tracked && { tracked: { processes: [...new Set(tracked.processes.map((p) => path.basename(p.image)))], events: tracked.events } }),
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

// ---- live tracking results ------------------------------------------------------------

// Registry paths as the kernel reports them, as normal key names.
export function registryName(raw, sid) {
  let k = String(raw || '').replace(/^\\REGISTRY\\MACHINE(?=\\|$)/i, 'HKEY_LOCAL_MACHINE');
  if (sid) {
    const esc = sid.replace(/-/g, '\\-');
    k = k.replace(new RegExp(`^\\\\REGISTRY\\\\USER\\\\${esc}_Classes(?=\\\\|$)`, 'i'), 'HKEY_CURRENT_USER\\Software\\Classes');
    k = k.replace(new RegExp(`^\\\\REGISTRY\\\\USER\\\\${esc}(?=\\\\|$)`, 'i'), 'HKEY_CURRENT_USER');
  }
  k = k.replace(/^\\REGISTRY\\USER(?=\\)/i, 'HKEY_USERS');
  return k.replace(/^HKEY_LOCAL_MACHINE\\SYSTEM\\ControlSet\d{3}(?=\\)/i, 'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet');
}

// Places that change all the time or belong to Windows' own bookkeeping, never to a program.
const LIVE_NOISE = /\\(temp|tmp)\\|\\\$recycle\.bin\\|\\system volume information\\|\\appdata\\local\\microsoft\\|\\programdata\\microsoft\\windows\\(wer|caches)\\|\\package cache\\|\\appdata\\local\\packages\\|\\inetcache\\|\\recent\\/i;
const KEY_NOISE = /\\(microsoft\\windows\\currentversion\\explorer|microsoft\\windows\\shell\\bag|microsoft\\windows nt\\currentversion\\appcompatflags|classes\\local settings|microsoft\\windows\\currentversion\\(installer|group policy)|microsoft\\(rasapi32|tracing|cryptography)|control\\deviceclasses|services\\bam\\)/i;

// Turns live tracking results into removal items, before checking which still exist.
export function liveItems(t, sid, installer) {
  const reason = `Seen being created by ${installer} during installation`;
  const own = (sys.info?.dataDir || '').toLowerCase();
  const fileOk = (p) => !isProtected(p) && !LIVE_NOISE.test(p + '\\') && !(own && p.toLowerCase().startsWith(own));
  const dirs = collapse(t.created_dirs.filter(fileOk));
  const files = t.created_files.filter((f) => fileOk(f) && !dirs.some((d) => f.toLowerCase().startsWith(d.toLowerCase() + '\\')));
  const keyNames = t.created_keys.map((k) => registryName(k, sid)).filter((k) => !KEY_NOISE.test(k) && !/^HKEY_USERS\\/i.test(k));
  const items = [
    ...dirs.map((p) => ({ kind: 'dir', path: p, confidence: 'high', score: 100, reason })),
    ...files.map((p) => ({ kind: 'file', path: p, confidence: 'high', score: 100, reason })),
  ];
  for (const k of collapse(keyNames)) {
    const service = k.match(SERVICE_KEY);
    if (service) items.push({ kind: 'service', path: service[1], confidence: 'high', score: 100, reason: `Service created by ${installer}` });
    else if (!isProtectedKey(k)) items.push({ kind: 'key', path: k, confidence: 'high', score: 100, reason });
  }
  const created = collapse(keyNames).map((k) => k.toLowerCase());
  for (const v of t.set_values) {
    const k = registryName(v.key, sid);
    // New values in existing keys; values inside new keys go with their key. Changed values are
    // put back from the snapshot comparison where it reached them.
    if (!v.new || KEY_NOISE.test(k) || /^HKEY_USERS\\/i.test(k) || created.some((c) => k.toLowerCase() === c || k.toLowerCase().startsWith(c + '\\'))) continue;
    items.push({ kind: 'value', path: k, name: v.name, confidence: 'high', score: 100, reason: `Value added by ${installer}` });
  }
  return items;
}

// Snapshot findings plus live findings, without repeating anything a folder or key already covers.
export function mergeItems(snapshot, live) {
  const out = [...snapshot];
  const id = (i) => `${i.kind}|${i.path}|${i.name || ''}`.toLowerCase();
  const seen = new Set(out.map(id));
  const covers = (i) =>
    out.some((o) => (o.kind === 'dir' && (i.kind === 'dir' || i.kind === 'file')) || (o.kind === 'key' && (i.kind === 'key' || i.kind === 'value')) ? i.path.toLowerCase().startsWith(o.path.toLowerCase() + '\\') : false);
  for (const i of live) {
    if (seen.has(id(i)) || covers(i)) continue;
    seen.add(id(i));
    out.push(i);
  }
  return out;
}

export { setRoot, start, attach, launch, status, cancel, finish, list, remove, collapse, recordItems };
