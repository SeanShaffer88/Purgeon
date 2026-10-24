// Command-line snapshots, run without a window:
//   SweepUninstall --snapshot "Before installing X" [--preset quick|standard|deep]
//   SweepUninstall --compare <before> <after|now> [--report file.html|.json|.txt]
//   SweepUninstall --list-snapshots
// A snapshot is named by its id, its name or "latest".
import { sys } from './backend/sys.js';
import * as snapshots from './backend/snapshots.js';
import * as monitor from './backend/monitor.js';
import * as maintenance from './backend/maintenance.js';
import { runCommandLine } from './backend/shell.js';

const HELP = `SweepUninstall command line

  --snapshot "<name>" [--preset quick|standard|deep]
        Takes a snapshot of files, folders and registry settings.
  --compare <before> <after|now> [--report <file.html|file.json|file.txt>]
        Compares two snapshots, or a snapshot with the system now, and
        lists what was added, removed and changed.
  --list-snapshots
        Lists saved snapshots.
  --maintenance
        Runs the weekly maintenance chosen in Tools › Scheduled Maintenance:
        a snapshot, the chosen junk clean-up and the backup limits.
  --monitor "<installer>" [--name "<program name>"]
        Records an installation: runs the installer, waits for it to finish
        and saves what it created and changed under Monitored Programs, so the
        program can be removed completely later. Run as administrator to also
        track the installer live.

Snapshots are named by id, by name, or "latest". Run from an administrator
terminal to see the output there; with --report the results are also saved
to a file. Exit code 0 means success, 1 means an error.
`;

const fmt = (c) => `${c.path}${c.kind === 'value' ? ` › ${c.name || '(default)'}` : ''}`;

function option(args, name) {
  const i = args.findIndex((a) => a.toLowerCase() === name);
  return i >= 0 ? args[i + 1] : undefined;
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
    for (const c of cmp[group]) lines.push(`${mark} ${c.kind.padEnd(5)} ${fmt(c)}${group === 'changed' && c.kind === 'value' ? `  [${c.before} -> ${c.after}]` : ''}`);
  }
  return lines.join('\r\n') + '\r\n';
}

async function run(args) {
  const cmd = args.find((a) => a.startsWith('--') || a === '-h' || a === '/?')?.toLowerCase();
  if (cmd === '--snapshot') {
    const name = option(args, '--snapshot');
    if (!name || name.startsWith('--')) throw new Error('Give the snapshot a name: --snapshot "Before installing X"');
    const preset = option(args, '--preset') || 'standard';
    if (!snapshots.PRESETS[preset]) throw new Error('--preset must be quick, standard or deep.');
    const meta = await snapshots.take(name, preset);
    const s = meta.stats;
    return `Snapshot "${meta.name}" (id ${meta.id}) taken: ${(s.dirs + s.files).toLocaleString()} files and folders, ${(s.keys + s.values).toLocaleString()} registry entries in ${(s.ms / 1000).toFixed(1)} s.\r\n`;
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
      // Loaded only when needed, so the command line also runs outside the app (tests).
      const body = /\.html?$/i.test(report) ? (await import('./snapshots.jsx')).comparisonHtml(all, before.name, afterName) : /\.json$/i.test(report) ? JSON.stringify(cmp, null, 2) : text;
      await sys.writeText(report, body);
      return `${text.split('\r\n').slice(0, 2).join('\r\n')}\r\nReport saved to ${report}\r\n`;
    }
    return text;
  }
  if (cmd === '--monitor') {
    const installer = option(args, '--monitor');
    if (!installer || installer.startsWith('--')) throw new Error('Name the installer: --monitor "C:\\Downloads\\setup.exe"');
    if (!(await sys.exists(installer))) throw new Error(`Installer not found: ${installer}`);
    if (await monitor.status()) throw new Error('Another installation is being monitored. Finish or cancel it in SweepUninstall first.');
    const started = await monitor.start(installer);
    if (started.live) {
      const pid = await sys.trackLaunch(installer);
      // Installers can run for a long time; wait up to four hours, then a moment for the last changes.
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
    return lines.join('\r\n') + '\r\n';
  }
  if (cmd === '--maintenance') {
    // Run by the weekly scheduled task (Tools › Scheduled Maintenance).
    const settings = await sys.readText(`${sys.info.dataDir}\\settings.json`).then(JSON.parse).catch(() => ({}));
    const out = await maintenance.run(settings.maintenance || {}, settings);
    return `${out.lines.join('\r\n')}\r\nReport: ${out.report}\r\n`;
  }
  if (cmd === '--list-snapshots') {
    const list = await snapshots.list();
    if (!list.length) return 'No snapshots yet.\r\n';
    const local = (iso) => {
      const t = new Date(iso);
      return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')} ${t.toTimeString().slice(0, 5)}`;
    };
    return list.map((s) => `${s.id}  ${local(s.created)}  ${s.preset.padEnd(8)}  ${s.name}`).join('\r\n') + '\r\n';
  }
  return HELP.replace(/\n/g, '\r\n');
}

export async function runCli(args) {
  let code = 0;
  try {
    await sys.print(`\r\n${await run(args)}`);
  } catch (e) {
    await sys.print(`\r\nError: ${e?.message || e}\r\n`);
    code = 1;
  }
  await sys.quit(code);
}
