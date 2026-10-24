// Command-line snapshots, run without a window:
//   SweepUninstall --snapshot "Before installing X" [--preset quick|standard|deep]
//   SweepUninstall --compare <before> <after|now> [--report file.html|.json|.txt]
//   SweepUninstall --list-snapshots
// A snapshot is named by its id, its name or "latest".
import { sys } from './backend/sys.js';
import * as snapshots from './backend/snapshots.js';

const HELP = `SweepUninstall command line

  --snapshot "<name>" [--preset quick|standard|deep]
        Takes a snapshot of files, folders and registry settings.
  --compare <before> <after|now> [--report <file.html|file.json|file.txt>]
        Compares two snapshots, or a snapshot with the system now, and
        lists what was added, removed and changed.
  --list-snapshots
        Lists saved snapshots.

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
