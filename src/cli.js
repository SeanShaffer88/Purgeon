// Command-line Purgeon, run without a window.
//
//   Purgeon --snapshot "Before installing X" [--preset quick|standard|deep]
//   Purgeon --compare <before> <after|now> [--report file.html|.json|.txt]
//   Purgeon --list-snapshots
//   Purgeon --maintenance
//   Purgeon --monitor "<installer>" [--name "<program name>"]
//   Purgeon --autostart on|off
//   Purgeon --background-scan
//   Purgeon --restore-point "<description>"
//   Purgeon --associations [--json]
//   Purgeon --associations-for "<program>" [--json]
//   Purgeon --schedule on|off [--scan-leftovers] [--check-startup] [--missed]
//   Purgeon --startup list|on|off|delayed|notdelayed --id <id>
//         Turns background monitoring on or off. --missed marks the last scheduled scan as missed.
//   Purgeon --sync status|apply|now [--files settings.json]
//         Shows or configures cloud-synced settings. apply takes --folder <path> and --on|--off.
//   Purgeon --plugins list|enable|disable|validate <id> [--json]
//         Manages user plugins; validate computes and stores script integrity hashes.
//   Purgeon --portableapps list
//         Lists monitored programs that can be packaged as PortableApps.com installers.
//   Purgeon --portableapps generate --monitor-id <id> --output <folder>
//         Creates a PortableApps.com directory structure and NSIS installer script
//         from a monitored program's recorded files.
//   Purgeon --profiler [--json]
//         Startup performance profile.
//   Purgeon --profiler baseline
//         Saves the current startup profile as the baseline for regression detection.
//   Purgeon --profiler regressions [--json]
//         Compares the current profile against the baseline and reports regressions.
//   Purgeon --language <code> [--json]
//   Purgeon --settings [--json]
//
// A snapshot is named by id, by name, or "latest". Run from an administrator
// terminal to see the output there; with --report the results are also saved
// to a file. Exit code 0 means success, 1 means an error, 2 means a usage error.
//
// --quiet suppresses the human-readable banner (still prints results unless --json).
// --json wraps every result in { ok, output, code } for scriptable use.

import { sys } from './backend/sys.js';
import * as snapshots from './backend/snapshots.js';
import * as monitor from './backend/monitor.js';
import * as maintenance from './backend/maintenance.js';
import * as autostart from './backend/autostart.js';
import * as schedule from './backend/schedule.js';
import * as restorepoint from './backend/restorepoint.js';
import * as associations from './backend/associations.js';
import * as i18n from './backend/i18n.js';
import * as plugins from './backend/plugins.js';
import * as profiler from './backend/profiler.js';
import * as sync from './backend/sync.js';
import * as startup from './backend/startup.js';
import * as portableapps from './backend/portableapps.js';
import { runCommandLine } from './backend/shell.js';

const HELP = `Purgeon command line

  --snapshot "<name>" [--preset quick|standard|deep]
        Takes a snapshot of files, folders and registry settings.
  --compare <before> <after|now> [--report <file.html|file.json|file.txt>]
        Compares two snapshots, or a snapshot with the system now.
  --list-snapshots
        Lists saved snapshots.
  --maintenance
        Runs the weekly maintenance chosen in Tools › Scheduled Maintenance.
  --monitor "<installer>" [--name "<program name>"]
        Records an installation for later complete removal.
  --autostart on|off
        Turns View › Start with Windows on or off.
  --background-scan
        Runs a headless leftover + startup scan (used by the scheduled task).
  --restore-point "<description>"
        Creates a Windows System Restore point.
  --associations [--json]
        Lists every file extension and the program that owns it.
  --associations-for "<program>" [--json]
        Lists extensions owned by the named program.
  --schedule on|off [--scan-leftovers] [--check-startup]
        Turns background monitoring on or off.
  --startup list|on|off|delayed|notdelayed --id <id>
        Lists startup entries, or enables/disables/delays one. id is type|name (e.g. service|Spooler).
  --language <code> [--json]
        Sets the UI language (en, es, de, fr).
  --plugins list|enable|disable <id> [--json]
        Manages user plugins in the plugins folder.
  --profiler [--json]
        Startup performance profile.
  --settings [--json]
        Shows current settings.

Snapshots are named by id, by name, or "latest". Run from an administrator
terminal to see the output there; with --report the results are also saved
to a file. Exit code 0 means success, 1 means an error, 2 means a usage error.
`;

// Exit codes: 0 success, 1 runtime error, 2 usage error.
const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_USAGE = 2;

const jsonMode = (args) => args.includes('--json') || args.includes('--json=true');
const quietMode = (args) => args.includes('--quiet') || args.includes('-q');

function option(args, name) {
  const i = args.findIndex((a) => a.toLowerCase() === name);
  return i >= 0 ? args[i + 1] : undefined;
}

function flag(args, name) {
  return args.some((a) => a.toLowerCase() === name);
}

async function find(ref) {
  const list = await snapshots.list(); // newest first
  if (!ref) throw new Error('Name a snapshot (its id, name or "latest").');
  if (ref.toLowerCase() === 'latest') {
    if (!list.length) throw new Error('There are no snapshots yet.');
    return list[0];
  }
  const hit = list.find((s) => s.id === ref) || list.find((s) => s.name.toLowerCase() === ref.toLowerCase());
  if (!hit) throw new Error(`No snapshot named "${ref}". Use --list-snapshots to see them.`);
  return hit;
}

function reportText(cmp, beforeName, afterName) {
  const lines = [`Comparison: ${beforeName} -> ${afterName}`, `Added ${cmp.added.length}, removed ${cmp.removed.length}, changed ${cmp.changed.length}${cmp.truncated ? ' (truncated)' : ''}`, ''];
  for (const [mark, group] of [['+', 'added'], ['-', 'removed'], ['~', 'changed']]) {
    for (const c of cmp[group]) lines.push(`${mark} ${c.kind.padEnd(5)} ${c.path}${c.kind === 'value' ? ` › ${c.name || '(default)'}` : ''}${group === 'changed' && c.kind === 'value' ? `  [${c.before} -> ${c.after}]` : ''}`);
  }
  return lines.join('\r\n') + '\r\n';
}

async function run(args) {
  const cmd = args.find((a) => a.startsWith('--') || a === '-h' || a === '/?')?.toLowerCase();
  const j = jsonMode(args);
  const wrap = (ok, output, code = EXIT_OK) => (j ? JSON.stringify({ ok, output, code }, null, 2) + '\r\n' : String(output));

  if (cmd === '--snapshot') {
    const name = option(args, '--snapshot');
    if (!name || name.startsWith('--')) throw new Error('Give the snapshot a name: --snapshot "Before installing X"');
    const preset = option(args, '--preset') || 'standard';
    if (!snapshots.PRESETS[preset]) throw new Error('--preset must be quick, standard or deep.');
    const meta = await snapshots.take(name, preset);
    const s = meta.stats;
    return wrap(true, `Snapshot "${meta.name}" (id ${meta.id}) taken: ${(s.dirs + s.files).toLocaleString()} files and folders, ${(s.keys + s.values).toLocaleString()} registry entries in ${(s.ms / 1000).toFixed(1)} s.\r\n`);
  }
  if (cmd === '--compare') {
    const i = args.findIndex((a) => a.toLowerCase() === '--compare');
    const before = await find(args[i + 1]);
    const afterRef = args[i + 2];
    if (!afterRef || afterRef.startsWith('--')) throw new Error('Name what to compare with: another snapshot, or "now".');
    const after = afterRef.toLowerCase() === 'now' ? null : await find(afterRef);
    const cmp = await snapshots.compare(before.id, after ? after.id : 'now', 200000);
    const afterName = after ? after.name : 'Now';
    const text = reportText(cmp, before.name, afterName);
    const report = option(args, '--report');
    if (report) {
      const all = Object.fromEntries(['added', 'removed', 'changed'].map((g) => [g, cmp[g].map((c) => ({ ...c, group: g }))]));
      const body = /\.html?$/i.test(report) ? (await import('./snapshots.jsx')).comparisonHtml(all, before.name, afterName) : /\.json$/i.test(report) ? JSON.stringify(cmp, null, 2) : text;
      await sys.writeText(report, body);
      return wrap(true, `${text.split('\r\n').slice(0, 2).join('\r\n')}\r\nReport saved to ${report}\r\n`);
    }
    return wrap(true, text);
  }
  if (cmd === '--monitor') {
    const installer = option(args, '--monitor');
    if (!installer || installer.startsWith('--')) throw new Error('Name the installer: --monitor "C:\\Downloads\\setup.exe"');
    if (!(await sys.exists(installer))) throw new Error(`Installer not found: ${installer}`);
    if (await monitor.status()) throw new Error('Another installation is being monitored. Finish or cancel it in Purgeon first.');
    const started = await monitor.start(installer);
    if (started.live) {
      const pid = await sys.trackLaunch(installer);
      await sys.waitProcess(pid, 4 * 3600 * 1000);
      await new Promise((r) => setTimeout(r, 2000));
    } else {
      await runCommandLine(`"${installer}"`);
    }
    const name = option(args, '--name') || installer.split('\\').pop().replace(/\.[^.]+$/, '');
    const rec = await monitor.finish(name);
    const lines = [
      `Recorded the installation of ${rec.name} (${started.live ? 'live tracking and snapshots' : 'snapshots only; run as administrator for live tracking'}).`,
      `${rec.items.length} items, saved under Monitored Programs.`,
      ...(rec.tracked ? [`Tracked processes: ${rec.tracked.processes.join(', ')}`] : []),
      '',
      ...rec.items.map((i) => `  ${i.kind.padEnd(8)} ${i.path}${i.name !== undefined ? ` › ${i.name || '(default)'}` : ''}  [${i.reason}]`),
    ];
    return wrap(true, lines.join('\r\n') + '\r\n');
  }
  if (cmd === '--maintenance') {
    const settings = await sys.readText(`${sys.info.dataDir}\\settings.json`).then(JSON.parse).catch(() => ({}));
    const out = await maintenance.run(settings.maintenance || {}, settings);
    return wrap(true, `${out.lines.join('\r\n')}\r\nReport: ${out.report}\r\n`);
  }
  if (cmd === '--autostart') {
    const v = String(option(args, '--autostart') || '').toLowerCase();
    if (v !== 'on' && v !== 'off') throw new Error('Use --autostart on or --autostart off.');
    const on = await autostart.set(v === 'on');
    return wrap(true, on ? 'Purgeon now starts when you sign in to Windows.\r\n' : 'Purgeon no longer starts with Windows.\r\n');
  }
  if (cmd === '--background-scan') {
    const result = await schedule.backgroundScan();
    return wrap(true, `Background scan complete: ${result.scanned} items scanned, ${result.leftovers.length} leftovers found.\r\n`);
  }
  if (cmd === '--restore-point') {
    const description = option(args, '--restore-point');
    if (!description || description.startsWith('--')) throw new Error('Give the restore point a name: --restore-point "Before cleaning junk"');
    const rp = await restorepoint.create(description);
    return wrap(rp.ok, rp.ok ? `Restore point "${description}" created (sequence ${rp.sequenceNumber}).\r\n` : `Failed to create restore point: ${rp.error || ''}\r\n`, rp.ok ? EXIT_OK : EXIT_ERROR);
  }
  if (cmd === '--associations') {
    const list = await associations.extensions();
    if (j) return wrap(true, JSON.stringify(list, null, 2));
    return wrap(true, list.map((e) => `${e.extension.padEnd(10)}  ${e.exe}\r\n`).join('') || 'No file associations found.\r\n');
  }
  if (cmd === '--associations-for') {
    const nameOrExe = option(args, '--associations-for');
    if (!nameOrExe || nameOrExe.startsWith('--')) throw new Error('Name a program: --associations-for "Foo Editor"');
    const list = await associations.extensionsForProgram(nameOrExe);
    if (j) return wrap(true, JSON.stringify(list, null, 2));
    return wrap(true, list.length ? list.map((e) => `${e.extension.padEnd(10)}  ${e.exe}\r\n`).join('') : `No extensions found for "${nameOrExe}".\r\n`);
  }
  if (cmd === '--schedule') {
    if (flag(args, '--missed')) {
      await schedule.markMissed();
      return wrap(true, 'Marked the last scheduled scan as missed; next background scan will retry.\r\n');
    }
    const v = String(option(args, '--schedule') || '').toLowerCase();
    if (v !== 'on' && v !== 'off') throw new Error('Use --schedule on or --schedule off.');
    const status = await schedule.apply({ enabled: v === 'on', scanLeftovers: flag(args, '--scan-leftovers'), checkStartup: flag(args, '--check-startup') });
    return wrap(true, status.registered ? 'Background monitoring is now on.\r\n' : 'Background monitoring is now off.\r\n');
  }
  if (cmd === '--startup') {
    const sub = option(args, '--startup');
    const id = option(args, '--id');
    if (!sub || sub.startsWith('--')) throw new Error('Use --startup list|on|off|delayed <id>.');
    if (sub === 'list') {
      const list = await startup.list();
      if (j) return wrap(true, JSON.stringify(list, null, 2));
      return wrap(true, list.map((e) => `${e.enabled ? '[x]' : '[ ]'} ${e.type === 'service' && e.delayed ? '[delayed] ' : ''}${e.name} — ${e.where}${e.admin ? ' (admin)' : ''}\r\n`).join('') || 'No startup entries.\r\n');
    }
    if (!id || id.startsWith('--')) throw new Error(`Use --startup ${sub} <id>.`);
    const [type, name] = id.split('|');
    const entry = { type, name, source: id, enabled: false };
    if (sub === 'on' || sub === 'off') {
      await startup.setEnabled(entry, sub === 'on');
      return wrap(true, `Startup entry ${name} ${sub === 'on' ? 'enabled' : 'disabled'}.\r\n`);
    }
    if (sub === 'delayed' || sub === 'notdelayed') {
      if (type !== 'service') throw new Error('Delayed start is only available for services.');
      await startup.setDelayed(entry, sub === 'delayed');
      return wrap(true, `Startup entry ${name} ${sub === 'delayed' ? 'delayed' : 'not delayed'}.\r\n`);
    }
    throw new Error('Use --startup list|on|off|delayed <id>.');
  }
  if (cmd === '--language') {
    const code = option(args, '--language');
    if (!code || code.startsWith('--')) throw new Error('Use --language <code>, e.g. --language en. Available: en, es, de, fr.');
    await i18n.setLanguage(code);
    return wrap(true, `Language set to ${code}.\r\n`);
  }
  if (cmd === '--plugins') {
    const sub = option(args, '--plugins');
    if (sub === 'list') {
      const list = await plugins.list();
      if (j) return wrap(true, JSON.stringify(list, null, 2));
      return wrap(true, list.map((p) => `${p.enabled ? '[x]' : '[ ]'} ${p.id} — ${p.name} (${p.description})\r\n`).join('') || 'No plugins.\r\n');
    }
    if (sub === 'enable' || sub === 'disable') {
      const id = option(args, `--${sub}`);
      if (!id || id.startsWith('--')) throw new Error(`Use --plugins ${sub} <id>.`);
      const result = await plugins.setEnabled(id, sub === 'enable');
      return wrap(true, `Plugin ${id} ${result.enabled ? 'enabled' : 'disabled'}.\r\n`);
    }
    throw new Error('Use --plugins list|enable|disable <id>.');
  }
  if (cmd === '--profiler') {
    const sub = option(args, '--profiler');
    if (sub === 'baseline') {
      const b = await profiler.saveBaseline();
      return wrap(true, `Baseline saved: ${b.totalMs.toFixed(0)} ms total, ${b.entries.length} modules.\r\n`);
    }
    if (sub === 'regressions') {
      const reg = await profiler.detectRegressions();
      if (j) return wrap(true, JSON.stringify(reg, null, 2));
      if (!reg.baseline) return wrap(true, 'No baseline saved yet. Run: Purgeon --profiler baseline\r\n');
      if (!reg.regressions.length) return wrap(true, 'No startup regressions detected vs baseline.\r\n');
      return wrap(true, reg.regressions.map((r) => `${r.label}: ${r.baselineMs.toFixed(0)} -> ${r.currentMs.toFixed(0)} ms (+${r.deltaPct}%)\r\n`).join(''));
    }
    const report = profiler.report();
    if (j) return wrap(true, JSON.stringify(report, null, 2));
    return wrap(true, report.lines.join('\r\n') + '\r\n');
  }
  if (cmd === '--sync') {
    const sub = option(args, '--sync');
    if (sub === 'status') {
      const st = await sync.status();
      if (j) return wrap(true, JSON.stringify(st, null, 2));
      return wrap(true, `Sync ${st.enabled ? 'on' : 'off'} · folder: ${st.folder || '(none)'} · last sync: ${st.lastSync || '(never)'} · conflict: ${st.conflict ? 'yes' : 'no'}\r\n`);
    }
    if (sub === 'apply') {
      const folder = option(args, '--folder');
      const on = option(args, '--on');
      const off = option(args, '--off');
      const files = option(args, '--files');
      const enabled = on ? true : off ? false : undefined;
      const fileList = files ? files.split(',').map((f) => f.trim()) : undefined;
      const st = await sync.apply({ folder, on: enabled, files: fileList });
      return wrap(true, `Sync ${st.enabled ? 'on' : 'off'} · folder: ${st.folder || '(none)'} · conflict: ${st.conflict ? 'yes' : 'no'}\r\n`);
    }
    if (sub === 'now') {
      const result = await sync.syncNow();
      if (j) return wrap(true, JSON.stringify(result, null, 2));
      return wrap(true, `Synced ${result.synced} file${result.synced !== 1 ? 's' : ''}${result.conflicts.length ? ` · ${result.conflicts.length} conflict(s): ${result.conflicts.join(', ')}` : ''}${result.errors.length ? ` · ${result.errors.length} error(s)` : ''}\r\n`);
    }
    throw new Error('Use --sync status|apply|now.');
  }
  if (cmd === '--plugins') {
    const sub = option(args, '--plugins');
    if (sub === 'validate') {
      const result = await plugins.validate();
      if (j) return wrap(true, JSON.stringify(result, null, 2));
      return wrap(true, result.map((r) => `${r.id}: ${r.integrity}${r.error ? ` (${r.error})` : ''}\r\n`).join(''));
    }
    if (sub === 'list') {
      const list = await plugins.list();
      if (j) return wrap(true, JSON.stringify(list, null, 2));
      return wrap(true, list.map((p) => `${p.enabled ? '[x]' : '[ ]'} ${p.id} — ${p.name} (${p.description}) [${p.permission}] ${p.integrity}\r\n`).join('') || 'No plugins.\r\n');
    }
    if (sub === 'enable' || sub === 'disable') {
      const id = option(args, `--${sub}`);
      if (!id || id.startsWith('--')) throw new Error(`Use --plugins ${sub} <id>.`);
      const result = await plugins.setEnabled(id, sub === 'enable');
      return wrap(true, `Plugin ${id} ${result.enabled ? 'enabled' : 'disabled'}.\r\n`);
    }
    throw new Error('Use --plugins list|enable|disable|validate <id>.');
  }
  if (cmd === '--portableapps') {
    const sub = option(args, '--portableapps');
    if (sub === 'list') {
      const list = await portableapps.list();
      if (j) return wrap(true, JSON.stringify(list, null, 2));
      return wrap(true, list.map((p) => `${p.hasProgramFiles ? '[+]' : '[-]'} ${p.id} — ${p.name} (${p.items} items, monitored ${p.finished.slice(0, 10)})\\r\\n`).join('') || 'No monitored programs.\\r\\n');
    }
    if (sub === 'generate') {
      const monitorId = option(args, '--monitor-id') || option(args, '--id');
      const outputDir = option(args, '--output') || option(args, '--dir');
      if (!monitorId || monitorId.startsWith('--')) throw new Error('Specify the monitored program id: --portableapps generate --monitor-id <id> --output <folder>');
      if (!outputDir || outputDir.startsWith('--')) throw new Error('Specify the output folder: --portableapps generate --monitor-id <id> --output <folder>');
      const appName = option(args, '--name');
      const appVersion = option(args, '--version');
      const appPublisher = option(args, '--publisher');
      const appHomepage = option(args, '--homepage');
      const appDescription = option(args, '--description');
      const startExe = option(args, '--start-exe');
      const result = await portableapps.generate({ monitorId, outputDir, appName, appVersion, appPublisher, appHomepage, appDescription, startExe });
      if (j) return wrap(true, JSON.stringify(result, null, 2));
      return wrap(true, `PortableApps.com package generated for "${result.name}" (${result.id}).\n  Package: ${result.packageDir}\n  NSIS script: ${result.nsiScriptPath}\n  AppInfo: ${result.appInfoPath}\n  Start exe: ${result.startExe}\n  Files copied: ${result.files.length}\nTo build the .paf.exe: place a PortableApps.com launcher as ${result.packageDir}\\\\${result.launcherExe}, then compile ${result.nsiScriptPath} with NSIS (makensis).\\r\\n`);
    }
    throw new Error('Use --portableapps list|generate --monitor-id <id> --output <folder>.');
  }
  if (cmd === '--settings') {
    const settings = await (await import('./backend/api.js')).readSettings();
    if (j) return wrap(true, JSON.stringify(settings, null, 2));
    return wrap(true, Object.entries(settings).map(([k, v]) => `${k}: ${v}\r\n`).join(''));
  }
  if (cmd === '-h' || cmd === '/?' || cmd === '--help' || !cmd) {
    return wrap(true, HELP.replace(/\n/g, '\r\n'));
  }
  throw new Error(`Unknown command: ${cmd}.`);
}

export async function runCli(args) {
  let code = EXIT_OK;
  try {
    const output = await run(args);
    if (!quietMode(args)) await sys.print(`\r\n${output}`);
  } catch (e) {
    code = e.exitCode === EXIT_USAGE ? EXIT_USAGE : EXIT_ERROR;
    if (!quietMode(args)) await sys.print(`\r\nError: ${e?.message || e}\r\n`);
  }
  await sys.quit(code);
}
