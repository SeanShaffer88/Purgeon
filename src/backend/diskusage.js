// What's eating your disk: the sizes of the folders and files inside any
// folder, biggest first, measured with the app's bounded folder-size engine.
// Read-only — nothing here changes, moves or deletes anything.
import { sys, env } from './sys.js';
import * as path from './winpath.js';
import { runPSJson } from './shell.js';

// ---- pure helpers (tested) ---------------------------------------------------

// Entries biggest first; folders before files when sizes tie, so the things
// you can open further stay grouped.
export const sortEntries = (entries) =>
  [...entries].sort((a, b) => b.bytes - a.bytes || Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));

// A path split into breadcrumb steps: [{ label, path }] from the drive down.
export function crumbsOf(p) {
  const clean = String(p || '').replace(/[\\/]+$/, '');
  const m = clean.match(/^([a-z]:)(.*)$/i);
  if (!m) return clean ? [{ label: clean, path: clean }] : [];
  const parts = m[2].split(/[\\/]+/).filter(Boolean);
  const out = [{ label: `${m[1]}\\`, path: `${m[1]}\\` }];
  let cur = m[1];
  for (const part of parts) {
    cur = `${cur}\\${part}`;
    out.push({ label: part, path: cur });
  }
  return out;
}

export const parentOf = (p) => {
  const crumbs = crumbsOf(p);
  return crumbs.length > 1 ? crumbs[crumbs.length - 2].path : null;
};

// Percentage of the parent folder, one decimal, as text ("12.4%").
export const shareText = (bytes, total) => (total > 0 ? `${((bytes / total) * 100).toFixed(1)}%` : '—');

// Plain-text rendering for the command line: drives, or one folder's contents.
export function toText({ drives: ds, scan: s }) {
  const gb = (b) => `${(b / 1073741824).toFixed(2)} GB`;
  const lines = [];
  if (ds) {
    lines.push('Drives:');
    for (const d of ds) lines.push(`  ${d.root}  ${gb(d.free)} free of ${gb(d.used + d.free)}`);
  }
  if (s) {
    lines.push(`In ${s.path} (${gb(s.total)} total${s.complete ? '' : ', scan stopped early'}):`);
    for (const e of s.entries.slice(0, 30)) lines.push(`  ${gb(e.bytes).padStart(10)}  ${shareText(e.bytes, s.total).padStart(6)}  ${e.name}${e.dir ? '\\' : ''}${e.partial ? ' (at least)' : ''}${e.link ? ' (link, not counted)' : ''}`);
  }
  return lines.join('\r\n') + '\r\n';
}

// ---- drives ------------------------------------------------------------------

// The PC's drives with their used and free space.
export async function drives() {
  const rows = await runPSJson(
    `@(Get-PSDrive -PSProvider FileSystem -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ root = $_.Root; used = [int64]$_.Used; free = [int64]$_.Free } })`
  ).catch(() => []);
  return (Array.isArray(rows) ? rows : [])
    .filter((d) => d && /^[a-z]:\\$/i.test(d.root || '') && (Number(d.used) || 0) + (Number(d.free) || 0) > 0)
    .map((d) => ({ root: d.root, used: Number(d.used) || 0, free: Number(d.free) || 0 }))
    .sort((a, b) => a.root.localeCompare(b.root));
}

export const systemDriveRoot = () => `${(env('SystemDrive') || 'C:').replace(/[\\/]+$/, '')}\\`;

// ---- scanning ------------------------------------------------------------------

// Measures one folder's children: [{ name, path, dir, bytes, partial }].
// Folders use the bounded folder-size engine (a folder whose measuring hit
// the bound is marked partial — its size is a lower bound). `shouldStop` is
// polled between entries; entries not yet measured come back with bytes -1
// left out, and the result's `complete` says whether everything was measured.
export async function scan(dir, shouldStop) {
  const entries = await sys.readDir(dir).catch(() => []);
  const out = [];
  let stopped = false;
  const queue = entries.filter((e) => !e.link);
  const links = entries.filter((e) => e.link);
  const worker = async () => {
    while (queue.length) {
      if (shouldStop && shouldStop()) {
        stopped = true;
        return;
      }
      const e = queue.shift();
      const full = path.join(dir, e.name);
      if (e.dir) {
        const r = await sys.folderSize(full, 2000000, 20000).catch(() => ({ bytes: 0, truncated: false }));
        out.push({ name: e.name, path: full, dir: true, bytes: r.bytes || 0, partial: !!r.truncated });
      } else {
        const st = await sys.stat(full).catch(() => null);
        out.push({ name: e.name, path: full, dir: false, bytes: st?.size || 0, partial: false });
      }
    }
  };
  await Promise.all(Array.from({ length: 3 }, worker));
  // Links (junctions, symlinks) are listed but never measured: following them
  // would count another folder's contents a second time.
  for (const e of links) out.push({ name: e.name, path: path.join(dir, e.name), dir: !!e.dir, bytes: 0, partial: false, link: true });
  const total = out.reduce((n, e) => n + Math.max(0, e.bytes), 0);
  return { path: dir, entries: sortEntries(out), total, complete: !stopped };
}
