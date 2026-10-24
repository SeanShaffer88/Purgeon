// Answers the UI's requests (window.api.invoke(channel, arg)) by calling the backend modules.
import { sys } from './sys.js';
import * as path from './winpath.js';
import { runCommandLine, reg, runPS, psq } from './shell.js';
import * as programs from './programs.js';
import * as leftovers from './leftovers.js';
import * as backups from './backups.js';
import * as monitor from './monitor.js';
import * as debloat from './debloat.js';
import * as restore from './restore.js';
import * as measure from './measure.js';
import * as startup from './startup.js';
import * as history from './history.js';
import * as snapshots from './snapshots.js';
import * as junk from './junk.js';
import * as groups from './groups.js';
import * as installers from './installers.js';
import * as safety from './safety.js';
import * as transfer from './transfer.js';

const DEFAULT_SETTINGS = { createRestorePoints: true, silentUninstall: false };
const settingsFile = () => path.join(sys.info.dataDir, 'settings.json');
const readSettings = () =>
  sys
    .readText(settingsFile())
    .then((t) => ({ ...DEFAULT_SETTINGS, ...JSON.parse(t) }))
    .catch(() => ({ ...DEFAULT_SETTINGS }));

const isAdmin = async () => (await sys.exec('net.exe', ['session'])).ok;

// Explorer opens folders, documents, programs and web links with the user's defaults.
const open = (target) => sys.launch('explorer.exe', [target]);

const measuredListeners = new Set();
let confirmUI = null;

// Inno Setup, NSIS and similar uninstallers keep running from %TEMP% under these names.
async function uninstallerStillRunning() {
  const out = await runPS(
    `@(Get-Process | Where-Object { $_.Path -and ($_.Path -like "$env:TEMP*" -or $_.ProcessName -match '^(unins\\d+|uninst|uninstall|un_a|au_|_iu14D2N|Au_)') }).Count`
  ).catch(() => '0');
  return Number(out.trim()) > 0;
}

const handlers = {
  'app:isAdmin': isAdmin,
  'app:quit': () => sys.quit(),
  'app:elevate': async () => {
    await runPS(`Start-Process -FilePath ${psq(sys.info.exe)} -Verb RunAs`);
    await sys.quit();
  },
  'settings:get': readSettings,
  'settings:set': async (patch) => {
    const next = { ...(await readSettings()), ...patch };
    await sys.writeText(settingsFile(), JSON.stringify(next, null, 2));
    return next;
  },
  'restore:create': async ({ description, kind }) => restore.create(description, kind, await isAdmin()),
  'programs:list': (kind) => (kind === 'store' ? programs.listStore() : programs.listDesktop()),
  // Each result is delivered to onMeasured listeners as soon as it is ready.
  'programs:measure': (list) => measure.measure(list, (result) => measuredListeners.forEach((fn) => fn(result))),
  'icons:get': (list) => programs.iconsFor(list),
  'program:runUninstaller': async (program) => {
    if (program.store) {
      await programs.removeStoreApp(program.key);
      return { ok: true };
    }
    // With Tools › Silent Uninstall turned on, uninstallers whose silent switches are known run without their windows.
    const silent = (await readSettings()).silentUninstall ? (await installers.describe(program)).silent : '';
    const cmd = silent || program.uninstall || program.quiet;
    if (!cmd) return { ok: false, error: 'This program has no uninstall command. Use Force Removal.' };
    const result = { ...(await runCommandLine(cmd)), silent: !!silent };
    // Many uninstallers relaunch themselves from %TEMP% and exit at once; wait for the
    // registry entry to disappear for a while before scanning.
    for (let i = 0; i < 120; i++) {
      const q = await reg(['query', program.key]);
      if (!q.ok) break;
      await new Promise((r) => setTimeout(r, 1000));
      if (i > 3 && !(await uninstallerStillRunning())) break;
    }
    return result;
  },
  'program:scan': (program) => leftovers.scan(program),
  // Read before uninstalling: the installer type and silent switches, the files its installer
  // recorded (these records go away with the uninstall), and what depends on the program.
  'program:prepare': async (program) => {
    const [installer, installerItems, dependencies] = await Promise.all([installers.describe(program), installers.installerItems(program).catch(() => []), safety.dependencyInfo(program).catch(() => null)]);
    return { installer, installerItems, dependencies };
  },
  'program:processes': (location) => leftovers.processesIn(location),
  'program:killProcesses': (ids) => runPS(`Stop-Process -Id ${ids.map(Number).join(',')} -Force -ErrorAction SilentlyContinue`),
  'items:remove': ({ title, items, owners }) => backups.removeItems({ title, items, owners }),
  'program:openFolder': async (location) => (location && (await sys.exists(location)) ? (await open(location), '') : 'Folder not found'),
  'program:openRegistry': async (key) => {
    const full = key.replace(/^HKLM\\/i, 'HKEY_LOCAL_MACHINE\\').replace(/^HKCU\\/i, 'HKEY_CURRENT_USER\\');
    await reg(['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Applets\\Regedit', '/v', 'LastKey', '/t', 'REG_SZ', '/d', `Computer\\${full}`, '/f']);
    await sys.launch('regedit.exe', ['/m']);
  },
  'program:search': (name) => open(`https://www.google.com/search?q=${encodeURIComponent(name)}`),
  'monitor:status': () => monitor.status(),
  'monitor:pickInstaller': async () => {
    const { open: openDialog } = await import('@tauri-apps/plugin-dialog');
    const file = await openDialog({ title: 'Choose the installer to monitor', multiple: false, filters: [{ name: 'Installers', extensions: ['exe', 'msi', 'msix', 'bat', 'cmd'] }] });
    return typeof file === 'string' ? file : null;
  },
  'monitor:start': (installer) => monitor.start(installer),
  'monitor:launch': (installer) => monitor.launch(installer, open),
  'monitor:finish': (name) => monitor.finish(name),
  'monitor:cancel': () => monitor.cancel(),
  'monitor:list': () => monitor.list(),
  'monitor:remove': (id) => monitor.remove(id),
  'backups:list': () => backups.list(),
  'backups:restore': (id) => backups.restore(id),
  'backups:remove': (id) => backups.remove(id),
  'snapshots:list': () => snapshots.list(),
  'snapshots:take': ({ name, preset }) => snapshots.take(name, preset),
  'snapshots:remove': (id) => snapshots.remove(id),
  'snapshots:rename': ({ id, name }) => snapshots.rename(id, name),
  'snapshots:compare': ({ before, after }) => snapshots.compare(before, after),
  'snapshots:cleanupItems': ({ before, selected }) => snapshots.cleanupItems(before, selected),
  'junk:scan': () => junk.scan(),
  'groups:get': () => groups.get(),
  'groups:set': ({ keys, group }) => groups.set(keys, group),
  'groups:restore': (previous) => groups.restore(previous),
  'transfer:pickSave': async (program) => {
    const { save } = await import('@tauri-apps/plugin-dialog');
    return save({ title: `Back up ${program.name}`, defaultPath: transfer.defaultFileName(program), filters: [{ name: 'SweepUninstall program backup', extensions: ['swpkg'] }] });
  },
  'transfer:pickOpen': async () => {
    const { open: openDialog } = await import('@tauri-apps/plugin-dialog');
    const file = await openDialog({ title: 'Restore a program backup', multiple: false, filters: [{ name: 'SweepUninstall program backup', extensions: ['swpkg'] }] });
    return typeof file === 'string' ? file : null;
  },
  'transfer:export': ({ program, items, file }) => transfer.exportProgram(program, items, file),
  'transfer:read': (file) => transfer.read(file),
  'transfer:restore': ({ file, numbers }) => transfer.restore(file, numbers),
  'transfer:undo': (id) => transfer.undo(id),
  'startup:list': () => startup.list(),
  'startup:set': ({ entry, enable }) => startup.setEnabled(entry, enable),
  'debloat:list': () => debloat.list(),
  'debloat:set': ({ id, enable }) => debloat.set(id, enable),
  'debloat:restartExplorer': () => debloat.restartExplorer(),
  'export:html': async ({ title, html, fileName = 'installed-programs.html' }) => {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const file = await save({ title, defaultPath: fileName, filters: [{ name: 'HTML', extensions: ['html'] }] });
    if (!file) return null;
    await sys.writeText(file, html);
    await open(file);
    return file;
  },
  // Shown by the app's own dialog (see setConfirmUI). With checkboxLabel it resolves to
  // { ok, checked }, otherwise to a boolean.
  'dialog:confirm': (options) => (confirmUI ? confirmUI(options) : Promise.resolve(options.checkboxLabel ? { ok: false, checked: false } : false)),
};

// Change History: what each change-making request records, with the request that undoes it.
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const recorders = {
  'debloat:set': ({ id, enable }) => {
    const t = debloat.TWEAKS.find((x) => x.id === id);
    return { type: 'Debloat', title: `${enable ? 'Applied' : 'Turned off'} "${t?.title || id}"`, undo: { channel: 'debloat:set', arg: { id, enable: !enable } } };
  },
  'startup:set': ({ entry, enable }) => ({
    type: entry.type === 'service' ? 'Service' : 'Startup',
    title: `${enable ? 'Turned on' : 'Turned off'} "${entry.name}"`,
    detail: entry.where,
    undo: { channel: 'startup:set', arg: { entry: { ...entry, enabled: enable }, enable: !enable } },
  }),
  'items:remove': ({ title }, result) => {
    const done = result.results.filter((r) => r.ok && !/already gone/i.test(r.detail || '')).length;
    return done && result.backupId ? { type: 'Removal', title: `Removed ${plural(done, 'item')}: ${title}`, detail: `Backup ${result.backupId}`, undo: { channel: 'backups:restore', arg: result.backupId } } : null;
  },
  'program:runUninstaller': (program, result) => ({
    type: 'Uninstall',
    title: `Ran the uninstaller for ${program.name}`,
    detail: result.ok ? 'Finished' : result.error || `Exit code ${result.code}`,
  }),
  'restore:create': ({ description }, result) =>
    result.created ? { type: 'Restore point', title: `Created restore point "${description}"`, detail: 'Use Windows System Restore to go back to it' } : null,
  'backups:restore': (id, results) => ({
    type: 'Restore',
    title: `Restored the backup of ${String(id).replace(/^[^_]*_/, '').replace(/-/g, ' ') || 'removed items'}`,
    detail: `${results.filter((r) => r.ok).length} of ${results.length} entries restored`,
  }),
  'snapshots:take': ({ preset }, meta) => ({
    type: 'Snapshot',
    title: `Took snapshot "${meta.name}"`,
    detail: `${(meta.stats.dirs + meta.stats.files + meta.stats.keys + meta.stats.values).toLocaleString()} entries (${preset})`,
  }),
  'groups:set': ({ keys, group, label }, previous) => ({
    type: 'Groups',
    title: group ? `Put ${label || plural(keys.length, 'program')} in the group "${group}"` : `Took ${label || plural(keys.length, 'program')} out of ${keys.length === 1 ? 'its group' : 'their groups'}`,
    undo: { channel: 'groups:restore', arg: previous },
  }),
  'transfer:export': ({ program }, out) => ({ type: 'Backup', title: `Backed up ${program.name}`, detail: out.file }),
  'transfer:restore': (_arg, out) =>
    out.results.some((r) => r.ok) ? { type: 'Restore', title: `Restored ${out.name} from a program backup`, detail: `${out.results.filter((r) => r.ok).length} of ${out.results.length} items`, undo: { channel: 'transfer:undo', arg: out.id } } : null,
  'monitor:finish': (_name, record) => ({ type: 'Monitor', title: `Recorded the installation of ${record.name}`, detail: plural(record.items.length, 'change') }),
};
for (const [channel, describe] of Object.entries(recorders)) {
  const run = handlers[channel];
  handlers[channel] = async (arg) => {
    const result = await run(arg);
    const entry = describe(arg, result);
    if (entry) await history.record(entry).catch(() => {});
    return result;
  };
}
handlers['history:list'] = () => history.list();
handlers['history:undo'] = async (id) => {
  const entry = (await history.list()).find((e) => e.id === id);
  if (!entry) throw new Error('That change is no longer in the history.');
  if (entry.undone) throw new Error('This change was already undone.');
  if (!entry.undo) throw new Error(entry.type === 'Uninstall' ? 'An uninstall cannot be undone here. Reinstall the program, or use the restore point made before it.' : 'This change cannot be undone here.');
  const result = await handlers[entry.undo.channel](entry.undo.arg);
  await history.markUndone(id);
  return result;
};

export const setConfirmUI = (fn) => {
  confirmUI = fn;
};

// Folders under the app's data directory, created on start.
export async function initBackend() {
  const data = sys.info.dataDir;
  await sys.makeDir(data);
  await Promise.all([
    backups.setRoot(path.join(data, 'backups')),
    monitor.setRoot(path.join(data, 'monitor')),
    startup.setRoot(path.join(data, 'startup')),
    debloat.setRoot(path.join(data, 'debloat')),
    history.setRoot(path.join(data, 'history')),
    snapshots.setRoot(path.join(data, 'snapshots')),
    groups.setRoot(path.join(data, 'groups')),
    transfer.setRoot(path.join(data, 'transfers')),
  ]);
}

export const api = {
  async invoke(channel, arg) {
    const fn = handlers[channel];
    if (!fn) throw new Error(`Unknown request ${channel}`);
    try {
      return await fn(arg);
    } catch (e) {
      throw e instanceof Error ? e : new Error(String(e));
    }
  },
  onMeasured(fn) {
    measuredListeners.add(fn);
    return () => measuredListeners.delete(fn);
  },
};

// Exposed for the screenshot/demo harness, which swaps handlers for made-up data.
export const __handlers = handlers;
