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

const DEFAULT_SETTINGS = { createRestorePoints: true };
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
    const cmd = program.uninstall || program.quiet;
    if (!cmd) return { ok: false, error: 'This program has no uninstall command. Use Force Removal.' };
    const result = await runCommandLine(cmd);
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
  'program:processes': (location) => leftovers.processesIn(location),
  'program:killProcesses': (ids) => runPS(`Stop-Process -Id ${ids.map(Number).join(',')} -Force -ErrorAction SilentlyContinue`),
  'items:remove': ({ title, items }) => backups.removeItems({ title, items }),
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
  'monitor:launch': (installer) => open(installer),
  'monitor:finish': (name) => monitor.finish(name),
  'monitor:cancel': () => monitor.cancel(),
  'monitor:list': () => monitor.list(),
  'monitor:remove': (id) => monitor.remove(id),
  'backups:list': () => backups.list(),
  'backups:restore': (id) => backups.restore(id),
  'backups:remove': (id) => backups.remove(id),
  'startup:list': () => startup.list(),
  'startup:set': ({ entry, enable }) => startup.setEnabled(entry, enable),
  'debloat:list': () => debloat.list(),
  'debloat:set': ({ id, enable }) => debloat.set(id, enable),
  'debloat:restartExplorer': () => debloat.restartExplorer(),
  'export:html': async ({ title, html }) => {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const file = await save({ title, defaultPath: 'installed-programs.html', filters: [{ name: 'HTML', extensions: ['html'] }] });
    if (!file) return null;
    await sys.writeText(file, html);
    await open(file);
    return file;
  },
  // Shown by the app's own dialog (see setConfirmUI). With checkboxLabel it resolves to
  // { ok, checked }, otherwise to a boolean.
  'dialog:confirm': (options) => (confirmUI ? confirmUI(options) : Promise.resolve(options.checkboxLabel ? { ok: false, checked: false } : false)),
};

export const setConfirmUI = (fn) => {
  confirmUI = fn;
};

// Folders under the app's data directory, created on start.
export async function initBackend() {
  const data = sys.info.dataDir;
  await sys.makeDir(data);
  await Promise.all([backups.setRoot(path.join(data, 'backups')), monitor.setRoot(path.join(data, 'monitor')), startup.setRoot(path.join(data, 'startup'))]);
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
