const { app, BrowserWindow, Menu, ipcMain, shell, dialog, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');
const programs = require('./programs.cjs');
const leftovers = require('./leftovers.cjs');
const backups = require('./backups.cjs');
const monitor = require('./monitor.cjs');
const debloat = require('./debloat.cjs');
const restore = require('./restore.cjs');
const measure = require('./measure.cjs');
const startup = require('./startup.cjs');
const { runCommandLine, reg, runPS, psq } = require('./shell.cjs');

let win;
const send = (action) => win && win.webContents.send('menu', action);

function buildMenu() {
  const item = (label, action, accelerator) => ({ label, accelerator, click: () => send(action) });
  return Menu.buildFromTemplate([
    {
      label: '&File',
      submenu: [
        item('Export to HTML...', 'export', 'CmdOrCtrl+S'),
        { type: 'separator' },
        item('Restart as Administrator', 'elevate'),
        { type: 'separator' },
        { label: 'Exit', role: 'quit' },
      ],
    },
    {
      label: '&Action',
      submenu: [
        item('Uninstall...', 'uninstall', 'Delete'),
        item('Force Removal...', 'force', 'Shift+Delete'),
        item('Analyze Leftovers...', 'analyze', 'CmdOrCtrl+L'),
        item('Remove Entry...', 'removeEntry'),
        { type: 'separator' },
        item('Registry Entry', 'registry'),
        item('Installation Folder', 'folder'),
        item('Search Online', 'search'),
        { type: 'separator' },
        item('Properties', 'properties', 'Alt+Enter'),
      ],
    },
    {
      label: '&View',
      submenu: [
        item('Desktop Programs', 'view:desktop', 'CmdOrCtrl+1'),
        item('Windows Store Apps', 'view:store', 'CmdOrCtrl+2'),
        item('Monitored Programs', 'view:monitored', 'CmdOrCtrl+3'),
        item('Backups', 'view:backups', 'CmdOrCtrl+4'),
        item('Debloat Windows', 'view:debloat', 'CmdOrCtrl+5'),
        item('Startup && Services', 'view:startup', 'CmdOrCtrl+6'),
        { type: 'separator' },
        item('Find...', 'find', 'CmdOrCtrl+F'),
        item('Refresh', 'refresh', 'F5'),
        ...(process.argv.includes('--dev') ? [{ type: 'separator' }, { role: 'toggleDevTools' }] : []),
      ],
    },
    {
      label: '&Tools',
      submenu: [item('Monitor an Installation...', 'monitor', 'CmdOrCtrl+M'), { type: 'separator' }, item('Create Restore Points', 'toggleRestore')],
    },
    { label: '&Help', submenu: [item('About', 'about')] },
  ]);
}

function createWindow() {
  win = new BrowserWindow({
    width: 760,
    height: 620,
    minWidth: 520,
    minHeight: 360,
    title: 'SweepUninstall',
    backgroundColor: '#0c0c0c',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: false },
  });
  // The native menu only supplies keyboard accelerators; the renderer draws a dark menu bar.
  win.setMenu(buildMenu());
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

const isAdmin = () =>
  new Promise((resolve) => execFile('net.exe', ['session'], { windowsHide: true }, (err) => resolve(!err)));

const DEFAULT_SETTINGS = { createRestorePoints: true };
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function readSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

const handlers = {
  'app:isAdmin': isAdmin,
  'settings:get': () => readSettings(),
  'settings:set': (patch) => {
    const next = { ...readSettings(), ...patch };
    fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
    return next;
  },
  'restore:create': async ({ description, kind }) => restore.create(description, kind, await isAdmin()),
  'app:elevate': async () => {
    // A packaged exe relaunches itself; in development electron.exe needs the app folder.
    const argv = app.isPackaged ? process.argv.slice(1) : [app.getAppPath(), ...process.argv.slice(2)];
    const args = argv.length ? ` -ArgumentList ${argv.map((a) => `'"${a.replace(/'/g, "''")}"'`).join(',')}` : '';
    await runPS(`Start-Process -FilePath ${psq(process.execPath)}${args} -Verb RunAs`);
    app.quit();
  },
  'programs:list': (kind) => (kind === 'store' ? programs.listStore() : programs.listDesktop()),
  // Streams each result to the window as a 'measured' event as soon as it is ready.
  'programs:measure': (list) => measure.measure(list, (result) => win && win.webContents.send('measured', result)),
  'icon:get': async (program) => {
    const p = programs.iconPathFor(program);
    if (!p || !fs.existsSync(p)) return null;
    try {
      const img = await app.getFileIcon(p, { size: 'small' });
      return img.isEmpty() ? null : img.toDataURL();
    } catch {
      return null;
    }
  },
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
  'program:scan': (program) => leftovers.scan(program, (f) => shell.readShortcutLink(f)),
  'program:processes': (location) => leftovers.processesIn(location),
  'program:killProcesses': (ids) => runPS(`Stop-Process -Id ${ids.map(Number).join(',')} -Force -ErrorAction SilentlyContinue`),
  'items:remove': ({ title, items }) => backups.removeItems({ title, items, trashItem: (p) => shell.trashItem(p) }),
  'program:openFolder': (location) => (location && fs.existsSync(location) ? shell.openPath(location) : 'Folder not found'),
  'program:openRegistry': async (key) => {
    const full = key.replace(/^HKLM\\/i, 'HKEY_LOCAL_MACHINE\\').replace(/^HKCU\\/i, 'HKEY_CURRENT_USER\\');
    await reg(['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Applets\\Regedit', '/v', 'LastKey', '/t', 'REG_SZ', '/d', `Computer\\${full}`, '/f']);
    spawn('regedit.exe', ['/m'], { detached: true, stdio: 'ignore', shell: true }).unref();
  },
  'program:search': (name) => shell.openExternal(`https://www.google.com/search?q=${encodeURIComponent(name)}`),
  'monitor:status': () => monitor.status(),
  'monitor:pickInstaller': async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose the installer to monitor',
      filters: [{ name: 'Installers', extensions: ['exe', 'msi', 'msix', 'bat', 'cmd'] }],
      properties: ['openFile'],
    });
    return r.canceled ? null : r.filePaths[0];
  },
  'monitor:start': (installer) => monitor.start(installer),
  'monitor:launch': (installer) => shell.openPath(installer),
  'monitor:finish': (name) => monitor.finish(name),
  'monitor:cancel': () => monitor.cancel(),
  'monitor:list': () => monitor.list(),
  'monitor:remove': (id) => monitor.remove(id),
  'backups:list': () => backups.list(),
  'startup:list': () => startup.list(),
  'startup:set': ({ entry, enable }) => startup.setEnabled(entry, enable),
  'debloat:list': () => debloat.list(),
  'debloat:set': ({ id, enable }) => debloat.set(id, enable),
  'debloat:restartExplorer': () => debloat.restartExplorer(),
  'backups:restore': (id) => backups.restore(id),
  'backups:remove': (id) => backups.remove(id),
  'export:html': async ({ title, html }) => {
    const r = await dialog.showSaveDialog(win, { title, defaultPath: 'installed-programs.html', filters: [{ name: 'HTML', extensions: ['html'] }] });
    if (r.canceled) return null;
    fs.writeFileSync(r.filePath, html, 'utf8');
    shell.openPath(r.filePath);
    return r.filePath;
  },
  // With checkboxLabel, resolves to { ok, checked } instead of a boolean.
  'dialog:confirm': async ({ message, detail, checkboxLabel, checkboxChecked }) => {
    const r = await dialog.showMessageBox(win, { type: 'question', buttons: ['Yes', 'No'], defaultId: 0, cancelId: 1, message, detail, checkboxLabel, checkboxChecked });
    return checkboxLabel ? { ok: r.response === 0, checked: r.checkboxChecked } : r.response === 0;
  },
};

// Inno Setup, NSIS and similar uninstallers keep running from %TEMP% under these names.
async function uninstallerStillRunning() {
  const out = await runPS(
    `@(Get-Process | Where-Object { $_.Path -and ($_.Path -like "$env:TEMP*" -or $_.ProcessName -match '^(unins\\d+|uninst|uninstall|un_a|au_|_iu14D2N|Au_)') }).Count`
  ).catch(() => '0');
  return Number(out.trim()) > 0;
}

app.whenReady().then(() => {
  nativeTheme.themeSource = 'dark'; // dark title bar and system dialogs
  const data = app.getPath('userData');
  backups.setRoot(path.join(data, 'backups'));
  monitor.setRoot(path.join(data, 'monitor'));
  startup.setRoot(path.join(data, 'startup'));
  for (const [channel, fn] of Object.entries(handlers)) {
    ipcMain.handle(channel, async (_e, arg) => fn(arg));
  }
  createWindow();
});

app.on('window-all-closed', () => app.quit());
