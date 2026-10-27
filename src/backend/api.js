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
import * as log from './log.js';
import * as owners from './owners.js';
import * as winget from './winget.js';
import * as trusted from './trusted.js';
import * as updatecheck from './updatecheck.js';
import { readSettings, writeSettings, DEFAULT_SETTINGS } from './settings.js';
// Cold-path modules are loaded on first use (lazy) to speed up startup:
// transfer, archive, insights, maintenance, queue, explore, browsers, portable,
// shellmenu, report, ctxmenu, installwatch, trials.
const lazyModule = (name) => {
  let mod = null;
  return {
    get: async () => (mod || (mod = await import(`./${name}.js`))),
  };
};
const lazyTransfer = lazyModule('transfer');
const lazyArchive = lazyModule('archive');
const lazyInsights = lazyModule('insights');
const lazyMaintenance = lazyModule('maintenance');
const lazyQueue = lazyModule('queue');
const lazyTrials = lazyModule('trials');
const lazyExplore = lazyModule('explore');
const lazyBrowsers = lazyModule('browsers');
const lazyPortable = lazyModule('portable');
const lazyShellmenu = lazyModule('shellmenu');
const lazyReport = lazyModule('report');
const lazyCtxmenu = lazyModule('ctxmenu');
const lazyInstallwatch = lazyModule('installwatch');
import * as running from './running.js';
import * as maintenance from './maintenance.js';
import * as queue from './queue.js';
import * as trials from './trials.js';
import * as explore from './explore.js';
import * as browsers from './browsers.js';
import * as portable from './portable.js';
import * as portableapps from './portableapps.js';
import * as shellmenu from './shellmenu.js';
import * as report from './report.js';
import * as ctxmenu from './ctxmenu.js';
import * as autostart from './autostart.js';
import * as installwatch from './installwatch.js';
// New modules (enhancements): i18n, schedule, associations, restorepoint, plugins, sync, profiler.
import * as i18n from './i18n.js';
import * as schedule from './schedule.js';
import * as associations from './associations.js';
import * as restorepoint from './restorepoint.js';
import * as plugins from './plugins.js';
import * as sync from './sync.js';
import * as profiler from './profiler.js';

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

// Before a destructive operation, create a Windows restore point when createRestorePoints is on.
// Returns { created, skipped, ...restorepoint fields }.
const maybeCreateRestorePoint = async (kind, description) => {
  const s = await readSettings();
  if (!s.createRestorePoints) return { created: false, skipped: true };
  return restorepoint.create(description);
};

const handlers = {
  'app:isAdmin': isAdmin,
  'app:quit': () => sys.quit(),
  'app:elevate': async () => {
    await runPS(`Start-Process -FilePath ${psq(sys.info.exe)} -Verb RunAs`);
    await sys.quit();
  },
  'settings:get': readSettings,
  'settings:set': async (patch) => writeSettings(patch),
  'restore:create': async ({ description, kind }) => restore.create(description, kind, await isAdmin()),
  'programs:list': (kind) => (kind === 'store' ? programs.listStore() : programs.listDesktop()),
  // Each result is delivered to onMeasured listeners as soon as it is ready.
  'programs:measure': (list) => measure.measure(list, (result) => measuredListeners.forEach((fn) => fn(result))),
  'icons:get': (list) => programs.iconsFor(list),
  'program:runUninstaller': async (program) => {
    const rp = await maybeCreateRestorePoint('uninstall', `Purgeon: before uninstalling ${program.name}`);
    if (program.store) {
      await programs.removeStoreApp(program.key);
      await (await lazyArchive.get()).add(program, 'store').catch(() => {});
      return { ok: true, restorePoint: rp };
    }
    // With Tools › Silent Uninstall turned on, uninstallers whose silent switches are known run without their windows.
    const silent = (await readSettings()).silentUninstall ? (await installers.describe(program)).silent : '';
    const cmd = silent || program.uninstall || program.quiet;
    if (!cmd) return { ok: false, error: 'This program has no uninstall command. Use Action › Force.' };
    const result = { ...(await runCommandLine(cmd)), silent: !!silent };
    // Recorded in the uninstall archive once the program's entry is gone (checked below).
    // Many uninstallers relaunch themselves from %TEMP% and exit at once; wait for the
    // registry entry to disappear for a while before scanning.
    for (let i = 0; i < 120; i++) {
      const q = await reg(['query', program.key]);
      if (!q.ok) break;
      await new Promise((r) => setTimeout(r, 1000));
      if (i > 3 && !(await uninstallerStillRunning())) break;
    }
    if (!(await reg(['query', program.key])).ok) await (await lazyArchive.get()).add(program, 'uninstalled').catch(() => {});
    return { ...result, restorePoint: rp };
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
  'items:remove': async ({ title, items, owners }) => {
    const rp = await maybeCreateRestorePoint('removal', `Purgeon: before removing ${title}`);
    const result = await backups.removeItems({ title, items, owners });
    return { ...result, restorePoint: rp };
  },
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
  'monitor:poll': () => monitor.poll(),
  'monitor:list': () => monitor.list(),
  'monitor:remove': (id) => monitor.remove(id),
  'backups:list': () => backups.list(),
  'backups:plan': ({ items, owners }) => backups.planRemoval({ items, owners }),
  'backups:forecast': ({ items }) => backups.forecastSize(items),
  'backups:interrupted': () => backups.interrupted(),
  'backups:resolveInterrupted': (action) => backups.resolveInterrupted(action),
  'backups:prune': async () => {
    const rp = await maybeCreateRestorePoint('prune', 'Purgeon: before pruning old backups under backup limits');
    const result = await backups.prune({ maxDays: Number((await readSettings()).backupMaxDays) || 0, maxMB: Number((await readSettings()).backupMaxMB) || 0 });
    return { ...result, restorePoint: rp };
  },
  'log:open': () => open(log.folder()),
  'backups:restore': (id) => backups.restore(id),
  'backups:remove': (id) => backups.remove(id),
  'snapshots:list': () => snapshots.list(),
  'snapshots:take': ({ name, preset }) => snapshots.take(name, preset),
  'snapshots:remove': (id) => snapshots.remove(id),
  'snapshots:rename': ({ id, name }) => snapshots.rename(id, name),
  'snapshots:compare': ({ before, after }) => snapshots.compare(before, after),
  'snapshots:cleanupItems': ({ before, selected }) => snapshots.cleanupItems(before, selected),
  'junk:scan': () => junk.scan(),
  'junk:scanSystem': () => junk.scanSystem(),
  'junk:cleanSystem': async (ids) => {
    const rp = await maybeCreateRestorePoint('junk-clean', 'Purgeon: before junk clean-up');
    const result = await junk.cleanSystem(ids);
    return { ...result, restorePoint: rp };
  },
  'programs:insights': async (list) => (await lazyInsights.get()).programInsights(list),
  'programs:recordSizes': async (list) => (await lazyInsights.get()).recordSizes(list).then(() => true),
  'programs:sizeHistory': async () => (await lazyInsights.get()).sizeHistory(),
  'files:signatures': async (paths) => Object.fromEntries(await (await lazyInsights.get()).signatures(paths)),
  'security:verifySignature': async ({ path }) => {
    const sigs = await (await lazyInsights.get()).signatures([path]);
    const sig = sigs.get(String(path).toLowerCase());
    return sig ? { status: sig.status, signer: sig.signer } : { status: 'Unknown', signer: '' };
  },
  'owners:who': (target) => owners.whoOwns(target),
  'owners:pick': async (folder) => {
    const { open: openDialog } = await import('@tauri-apps/plugin-dialog');
    const file = await openDialog({ title: folder ? 'Choose a folder' : 'Choose a file', directory: !!folder, multiple: false });
    return typeof file === 'string' ? file : null;
  },
  'orphans:scan': () => owners.orphans(),
  'winget:available': () => winget.available(),
  'winget:upgrades': () => winget.upgrades(),
  'winget:upgrade': (id) => winget.upgrade(id),
  'winget:find': (name) => winget.find(name),
  'winget:install': (id) => winget.install(id),
  'winget:export': async () => {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const file = await save({ title: 'Export program list for winget', defaultPath: 'my-programs.winget.json', filters: [{ name: 'winget package list', extensions: ['json'] }] });
    return file ? winget.exportList(file) : null;
  },
  'archive:list': async () => (await lazyArchive.get()).list(),
  'archive:add': async ({ program, how }) => (await lazyArchive.get()).add(program, how),
  'archive:attachBackup': async ({ keys, backupId }) => (await lazyArchive.get()).attachBackup(keys, backupId),
  'archive:setPackage': async ({ id, wingetId }) => (await lazyArchive.get()).setPackage(id, wingetId),
  'archive:remove': async (id) => (await lazyArchive.get()).remove(id),
  'running:bootImpact': () => running.bootImpact(),
  'running:inbound': () => running.inboundRules(),
  'maintenance:status': () => maintenance.status(),
  'maintenance:apply': async (m) => {
    const next = { ...(await readSettings()), maintenance: { ...maintenance.DEFAULTS, ...m } };
    await writeSettings(next);
    return maintenance.apply(next.maintenance);
  },
  'maintenance:runNow': async () => {
    const s = await readSettings();
    return maintenance.run(s.maintenance || {}, s);
  },
  // 1. uninstall queue
  'queue:get': () => queue.get(),
  'queue:add': (programs) => queue.add(programs),
  'queue:remove': (key) => queue.remove(key),
  'queue:save': (q) => queue.save(q),
  'queue:clear': () => queue.clear(),
  'queue:arm': () => queue.arm(),
  'queue:disarm': () => queue.disarm(),
  'queue:restartPending': () => queue.restartPending(),
  'queue:restartNow': () => queue.restartNow(),
  // 2. programs removed outside Purgeon
  'programs:outside': async (list) => (await lazyArchive.get()).outside(list),
  // 3. trial installs
  'trials:list': () => trials.list(),
  'trials:start': ({ installer, name }) => trials.start(installer, name),
  'trials:launch': (installer) => open(installer),
  'trials:tryOver': async (id) => {
    const rp = await maybeCreateRestorePoint('trial', `Purgeon: before ending trial ${id}`);
    const result = await trials.tryOver(id);
    return { ...result, restorePoint: rp };
  },
  'trials:finish': (id) => trials.finish(id),
  // 4. rescue a broken uninstaller
  'winget:repair': (id) => winget.repair(id),
  'winget:exportTo': (file) => winget.exportList(file),
  // 5-8. exploring
  'explore:diskMap': (list) => explore.diskMap(list),
  'explore:timeline': async (list) => explore.timeline(list, sys.uninstallKeyTimes ? await sys.uninstallKeyTimes().catch(() => ({})) : {}),
  'program:sheet': (program) => explore.sheet(program),
  'program:analyze': (program) => explore.analyze(program),
  'registry:search': (term) => explore.searchRegistry(term),
  // 9-10. startup trust and new entries
  'startup:trust': async (entries) => {
    const exe = (cmd) => ((String(cmd || '').match(/^\s*"([^"]+)"|^\s*(\S+?\.exe)\b/i) || [])[1] || (String(cmd || '').match(/^\s*(\S+?\.exe)\b/i) || [])[1] || '').replace(/%([^%]+)%/g, (_, v) => sys.info.env[v] || `%${v}%`);
    const files = entries.map((e) => exe(e.command));
    const sigs = await insights.signatures(files.filter(Boolean));
    const out = {};
    for (const [i, e] of entries.entries()) {
      const f = files[i];
      const st = f ? await sys.stat(f).catch(() => null) : null;
      const reasons = running.trustReasons(e.command, f ? sigs.get(f.toLowerCase()) : null, st?.created);
      if (reasons.length) out[e.id] = reasons;
    }
    return out;
  },
  'startup:newEntries': async () => running.newEntries(await startup.list()),
  'startup:accept': (entries) => running.accept(entries),
  // 11. browsers
  'browsers:list': () => browsers.list(),
  'browsers:running': () => browsers.running(),
  // 13-14. whole-PC migration and settings sync
  'transfer:pickFolder': async (title) => {
    const { open: openDialog } = await import('@tauri-apps/plugin-dialog');
    const dir = await openDialog({ title: title || 'Choose a folder', directory: true, multiple: false });
    return typeof dir === 'string' ? dir : null;
  },
  'transfer:folder': async (folder) => (await lazyTransfer.get()).folderPackages(folder),
  // 15. portable apps
  // The folders you added are kept in the settings and looked at every time.
  'portable:find': async () => {
    const folders = (await readSettings()).portableFolders || [];
    return { folders, apps: await portable.find(folders) };
  },
  'portable:addFolder': async (folder) => {
    const s = await readSettings();
    const folders = [...new Set([...(s.portableFolders || []), folder])];
    await writeSettings({ portableFolders: folders });
    return folders;
  },
  'portable:removeFolder': async (folder) => {
    const s = await readSettings();
    const folders = (s.portableFolders || []).filter((f) => f.toLowerCase() !== String(folder).toLowerCase());
    await writeSettings({ portableFolders: folders });
    return folders;
  },
  'portable:checkUpdates': (apps) => portable.checkUpdates(apps),
  'portable:register': (app) => portable.register(app),
  'portable:unregister': (key) => portable.unregister(key),
  // PortableApps.com installer generation from monitored programs
  'portableapps:list': () => portableapps.list(),
  'portableapps:generate': (args) => portableapps.generate(args),
  // 16. Explorer right-click menu
  'shell:enabled': () => shellmenu.enabled(),
  'shell:enable': () => shellmenu.enable(),
  'shell:disable': () => shellmenu.disable(),
  'shell:resolve': (p) => shellmenu.resolveTarget(p),
  // 18. tray
  'app:setTray': (o) => (sys.setTray ? sys.setTray(o) : null),
  // Window options
  'app:setOnTop': (on) => (sys.setOnTop ? sys.setOnTop(on) : null),
  'app:show': () => (sys.showWindow ? sys.showWindow() : null),
  'app:hideToTray': () => (sys.hideToTray ? sys.hideToTray() : null),
  'app:closeAnswered': () => (sys.closeAnswered ? sys.closeAnswered() : null),
  'autostart:enabled': () => autostart.enabled(),
  'autostart:set': (on) => autostart.set(on),
  // Enhancement 1: localization
  'i18n:languages': () => i18n.languages(),
  'i18n:current': () => i18n.language(),
  'i18n:set': (code) => i18n.setLanguage(code),
  // Enhancement 3: scheduled background monitoring
  'schedule:status': () => schedule.status(),
  'schedule:apply': (settings) => schedule.apply(settings),
  'schedule:backgroundScan': () => schedule.backgroundScan(),
  // Enhancement 4: file association / extension ownership lookup
  'associations:extensions': () => associations.extensions(),
  'associations:ownerFor': (extension) => associations.ownerFor(extension),
  'associations:extensionsForProgram': (nameOrExe) => associations.extensionsForProgram(nameOrExe),
  // Enhancement 5: System Restore point integration
  'restorepoint:create': (description) => restorepoint.create(description),
  'restorepoint:list': () => restorepoint.list(),
  // Enhancement 6: plugin / user-script architecture
  'plugins:list': () => plugins.list(),
  'plugins:setEnabled': ({ id, enabled }) => plugins.setEnabled(id, enabled),
  'plugins:runLeftoverRules': (id) => plugins.runLeftoverRules(id),
  // Enhancement 9: cloud-synced settings and backup index
  'sync:status': () => sync.status(),
  'sync:apply': ({ folder, on }) => sync.apply({ folder, on }),
  'sync:syncNow': () => sync.syncNow(),
  // Enhancement 10: startup profiler
  'profiler:report': () => profiler.report(),
  'profiler:baseline': () => profiler.saveBaseline(),
  'profiler:regressions': () => profiler.detectRegressions(),
  // Enhancement 3: mark a scheduled scan as missed (PC was offline/asleep)
  'schedule:markMissed': () => schedule.markMissed(),
  // Enhancement 3: plugin integrity validation (compute and store script hashes)
  'plugins:validate': () => plugins.validate(),
  // Installers spotted as they start, and monitoring one that is already running
  'installers:check': () => installwatch.check(),
  'monitor:attach': ({ installer, name }) => monitor.attach(installer, name),
  // 21. Explorer context menu items
  'ctxmenu:list': () => ctxmenu.list(),
  'ctxmenu:set': ({ entry, enable }) => ctxmenu.set(entry, enable),
  // 19. reports
  'report:monthly': ({ month, programs: list, insight }) => report.monthly(month, list, insight),
  'open:url': (url) => {
    if (!/^https?:\/\/[^\s"]+$/i.test(url || '')) throw new Error('Not a web address');
    return open(url);
  },
  'groups:get': () => groups.get(),
  'groups:set': ({ keys, group }) => groups.set(keys, group),
  'groups:restore': (previous) => groups.restore(previous),
  'transfer:pickSave': async (program) => {
    const { save } = await import('@tauri-apps/plugin-dialog');
    return save({ title: `Back up ${program.name}`, defaultPath: (await lazyTransfer.get()).defaultFileName(program), filters: [{ name: 'Purgeon program backup', extensions: ['swpkg'] }] });
  },
  'transfer:pickOpen': async () => {
    const { open: openDialog } = await import('@tauri-apps/plugin-dialog');
    const file = await openDialog({ title: 'Restore a program backup', multiple: false, filters: [{ name: 'Purgeon program backup', extensions: ['swpkg'] }] });
    return typeof file === 'string' ? file : null;
  },
  'transfer:export': async ({ program, items, file, contents }) => (await lazyTransfer.get()).exportProgram(program, items, file, contents),
  'transfer:classify': async (items) => { const t = await lazyTransfer.get(); return items.map((i) => t.isSettings(i)); },
  'transfer:read': async (arg) => { const t = await lazyTransfer.get(); return typeof arg === 'string' ? t.read(arg) : t.read(arg.file, { replace: !!arg.replace }); },
  'transfer:restore': async ({ file, numbers, replace }) => (await lazyTransfer.get()).restore(file, numbers, { replace: !!replace }),
  'transfer:undo': async (id) => (await lazyTransfer.get()).undo(id),
  'startup:list': () => startup.list(),
  'startup:set': ({ entry, enable }) => startup.setEnabled(entry, enable),
  'startup:delayed': ({ entry, delayed }) => startup.setDelayed(entry, delayed),
  // Trusted publisher allowlist (Enhancement 5)
  'trusted:list': () => trusted.list(),
  'trusted:add': (name) => trusted.add(name),
  'trusted:remove': (name) => trusted.remove(name),
  'trusted:isTrusted': (signer) => trusted.isTrusted(signer),
  'trusted:filterInsights': (insights) => trusted.filterInsights(insights),
  // Opt-in update checker (Enhancement 6)
  'update:settings': () => updatecheck.settings(),
  'update:enable': (on) => updatecheck.enable(on),
  'update:check': () => updatecheck.check(),
  // Backup removal plan export (Enhancement 7)
  'backups:exportPlan': ({ plan, format, fileName }) => backups.exportPlan({ plan, format, fileName }),
  'debloat:list': () => debloat.list(),
  'debloat:set': async ({ id, enable }) => {
    const t = debloat.TWEAKS?.find((x) => x.id === id);
    const rp = await maybeCreateRestorePoint('debloat', `Purgeon: before debloat tweak ${t?.title || id}`);
    const result = await debloat.set(id, enable);
    return { ...result, restorePoint: rp };
  },
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
  'junk:cleanSystem': (_ids, results) =>
    results.some((r) => r.ok)
      ? { type: 'Clean-up', title: `Windows clean-up: ${results.filter((r) => r.ok).map((r) => r.label).join(', ')}`, detail: `${(results.reduce((n, r) => n + (r.freed || 0), 0) / 1048576).toFixed(1)} MB freed · done by Windows itself; cannot be undone` }
      : null,
  'winget:upgrade': (id, r) => (r.ok ? { type: 'Update', title: `Updated ${id} with winget` } : null),
  'winget:install': (id, r) => (r.ok ? { type: 'Install', title: `Reinstalled ${id} with winget` } : null),
  'maintenance:apply': (_m, s) => ({ type: 'Settings', title: s.registered ? 'Scheduled weekly maintenance' : 'Turned off scheduled maintenance' }),
  'ctxmenu:set': ({ entry, enable }) => ({ type: 'Context menu', title: `Turned ${enable ? 'on' : 'off'} "${entry.name}" in Explorer's right-click menu`, detail: entry.place, undo: { channel: 'ctxmenu:set', arg: { entry: { ...entry, enabled: enable }, enable: !enable } } }),
  'trials:start': ({ name }) => ({ type: 'Trial', title: `Started a trial install of ${name}` }),
  'trials:finish': (id) => ({ type: 'Trial', title: 'Ended a trial install' }),
  'winget:repair': (id, r) => (r.ok ? { type: 'Install', title: `Reinstalled ${id} to repair its uninstaller` } : null),
  'portable:register': (app, out) => ({ type: 'Portable', title: `Registered the portable app ${out.name}`, detail: app.folder, undo: { channel: 'portable:unregister', arg: out.key } }),
  'shell:enable': () => ({ type: 'Settings', title: 'Added Purgeon to Explorer’s right-click menu', undo: { channel: 'shell:disable', arg: null } }),
  'shell:disable': () => ({ type: 'Settings', title: 'Removed Purgeon from Explorer’s right-click menu', undo: { channel: 'shell:enable', arg: null } }),
  'transfer:export': ({ program, contents }, out) => ({ type: 'Backup', title: `Packaged ${program.name}${contents === 'program' ? ' (program only)' : contents === 'settings' ? ' (settings only)' : ''}`, detail: out.file }),
  'transfer:restore': (_arg, out) =>
    out.results.some((r) => r.ok) ? { type: 'Restore', title: `Restored ${out.name} from a program backup`, detail: `${out.results.filter((r) => r.ok).length} of ${out.results.length} items`, undo: { channel: 'transfer:undo', arg: out.id } } : null,
  'backups:resolveInterrupted': (action, out) =>
    action === 'rollback'
      ? { type: 'Restore', title: 'Rolled back an interrupted removal', detail: `${out.results.filter((r) => r.ok).length} of ${out.results.length} entries restored` }
      : action === 'finish' && out.backupId
        ? { type: 'Removal', title: 'Finished an interrupted removal', detail: `Backup ${out.backupId}`, undo: { channel: 'backups:restore', arg: out.backupId } }
        : null,
  'backups:prune': (_arg, removed) => (removed.length ? { type: 'Backups', title: `Removed ${plural(removed.length, 'old backup')} under the backup limits` } : null),
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
  // Every command Purgeon runs from here on is written to the command log.
  await log.setRoot(path.join(data, 'logs'));
  log.wrap(sys);
  log.write(`---- Purgeon ${sys.info.exe} started`);
  await Promise.all([
    backups.setRoot(path.join(data, 'backups')),
    monitor.setRoot(path.join(data, 'monitor')),
    startup.setRoot(path.join(data, 'startup')),
    debloat.setRoot(path.join(data, 'debloat')),
    history.setRoot(path.join(data, 'history')),
    snapshots.setRoot(path.join(data, 'snapshots')),
    groups.setRoot(path.join(data, 'groups')),
    (await lazyTransfer.get()).setRoot(path.join(data, 'transfers')),
    (await lazyInsights.get()).setRoot(path.join(data, 'insights')),
    (await lazyArchive.get()).setRoot(path.join(data, 'archive')),
    maintenance.setRoot(path.join(data, 'reports')),
    queue.setRoot(path.join(data, 'queue')),
    trials.setRoot(path.join(data, 'trials')),
    running.setRoot(path.join(data, 'startup')),
    schedule.setRoot(path.join(data, 'schedule')),
    plugins.setRoot(path.join(data, 'plugins')),
    portableapps.setRoot(path.join(data, 'portableapps')),
    sync.setRoot(path.join(data, 'sync')),
    profiler.setRoot(path.join(data, 'profiles')),
  ]);
  // Record that the core modules loaded; cold modules are loaded on first use below.
  profiler.mark('backend:init');
}

profiler.mark('api:imports-loaded');

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
