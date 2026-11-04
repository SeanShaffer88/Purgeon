// Windows Package Manager (winget): available updates, updating, finding a program's package
// to reinstall it, and exporting the installed programs as a list winget can install on another PC.
import { sys } from './sys.js';

const COMMON = ['--accept-source-agreements', '--disable-interactivity'];

async function run(args) {
  const r = await sys.exec('winget', [...args, ...COMMON]);
  return { ...r, stdout: String(r.stdout || '') };
}

export async function available() {
  const r = await sys.exec('winget', ['--version']).catch(() => ({ ok: false }));
  return r.ok ? String(r.stdout).trim() : '';
}

// winget prints tables: a header line, a line of dashes, then rows aligned to the header's
// columns. Progress spinners and notes before the header are ignored.
export function parseTable(text) {
  const lines = String(text)
    .split(/\r?\n/)
    .map((l) => l.replace(/^.*\r/, '').replace(/\s+$/, ''));
  const dash = lines.findIndex((l, i) => i > 0 && /^-{10,}$/.test(l.trim()));
  if (dash < 1) return [];
  const header = lines[dash - 1];
  const names = header.split(/\s{1,}/).filter(Boolean);
  const starts = [];
  let from = 0;
  for (const n of names) {
    const at = header.indexOf(n, from);
    starts.push(at);
    from = at + n.length;
  }
  const rows = [];
  for (const line of lines.slice(dash + 1)) {
    if (!line.trim() || /^\d+ (upgrades?|packages?) available|^The following|^\d+ package\(s\)/i.test(line.trim())) continue;
    if (line.length < starts[1]) continue;
    const row = {};
    names.forEach((n, i) => (row[n.toLowerCase()] = line.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : undefined).trim()));
    rows.push(row);
  }
  return rows;
}

// Installed programs with a newer version: [{ name, id, version, available, source }].
export async function upgrades() {
  const r = await run(['upgrade', '--include-unknown']);
  return parseTable(r.stdout)
    .filter((x) => x.id && x.available)
    .map((x) => ({ name: x.name, id: x.id, version: x.version, available: x.available, source: x.source || '' }));
}

// Updates one package silently. The package's license terms are accepted, as the UI says.
export async function upgrade(id) {
  if (!/^[\w.+-]{2,128}$/.test(id)) throw new Error('Invalid package id');
  const r = await run(['upgrade', '--id', id, '--exact', '--silent', '--accept-package-agreements']);
  return { ok: r.ok, detail: r.ok ? 'Updated' : (r.stdout.split(/\r?\n/).reverse().find((l) => l.trim()) || `winget exited with code ${r.code}`).trim() };
}

// The winget package id for a program name, when one matches exactly.
export async function find(name) {
  const r = await run(['search', '--name', name, '--exact']);
  return parseTable(r.stdout)[0]?.id || null;
}

// A package's latest version and web page: { version, homepage }.
export async function show(id) {
  if (!/^[\w.+-]{2,128}$/.test(id)) throw new Error('Invalid package id');
  const r = await run(['show', '--id', id, '--exact']);
  const field = (name) => (r.stdout.match(new RegExp(`^\\s*${name}:\\s*(.+)$`, 'mi')) || [])[1]?.trim() || '';
  return { version: field('Version'), homepage: field('Homepage') || field('Publisher Url') || field('Release Notes Url') };
}

export async function install(id) {
  if (!/^[\w.+-]{2,128}$/.test(id)) throw new Error('Invalid package id');
  const r = await run(['install', '--id', id, '--exact', '--accept-package-agreements']);
  return { ok: r.ok, detail: r.ok ? 'Installed' : (r.stdout.split(/\r?\n/).reverse().find((l) => l.trim()) || `winget exited with code ${r.code}`).trim() };
}

// Writes winget's own export file (JSON); "winget import -i <file>" installs them all on another PC.
export async function exportList(file) {
  const r = await run(['export', '-o', file, '--include-versions']);
  if (!(await sys.exists(file))) throw new Error((r.stdout || r.stderr || 'winget could not export the list').trim());
  const json = JSON.parse((await sys.readText(file)).replace(/^\uFEFF/, ''));
  return { file, packages: (json.Sources || []).reduce((n, s) => n + (s.Packages || []).length, 0) };
}

// Reinstalls a package over the existing copy, to repair a broken uninstaller.
export async function repair(id) {
  if (!/^[\w.+-]{2,128}$/.test(id)) throw new Error('Invalid package id');
  const r = await run(['install', '--id', id, '--exact', '--force', '--silent', '--accept-package-agreements']);
  return { ok: r.ok, detail: r.ok ? 'Reinstalled' : (r.stdout.split(/\r?\n/).reverse().find((l) => l.trim()) || `winget exited with code ${r.code}`).trim() };
}
