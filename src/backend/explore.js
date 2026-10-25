// Ways to look around: where disk space goes per program, a timeline of changes, a sheet of
// everything a program hooks into Windows, and a registry search.
import { sys } from './sys.js';
import * as path from './winpath.js';
import { runPSJson } from './shell.js';
import { fileRoots, GENERIC, isProtected } from './paths.js';
import { nameKey, publisherKey, nameMatches, merge, scan } from './leftovers.js';
import * as history from './history.js';
import * as snapshots from './snapshots.js';
import * as monitor from './monitor.js';
import * as archive from './archive.js';
import * as startup from './startup.js';
import { inboundRules } from './running.js';
import * as installers from './installers.js';
import { dependencyInfo } from './safety.js';
import { processesIn } from './leftovers.js';
import { programExe } from './insights.js';

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const clean = (p) => String(p || '').replace(/^"|"$/g, '').trim().replace(/\\+$/, '');
const under = (c, p) => c.toLowerCase() === p.toLowerCase() || c.toLowerCase().startsWith(p.toLowerCase() + '\\');

// ---- disk-space map ----------------------------------------------------------------------

// Each program's install folder plus its data folders (named after it, or after its publisher
// inside a publisher folder), measured: [{ key, name, install, data: [{ path, bytes }], total }].
export async function diskMap(programs) {
  const keys = programs.map((p) => ({ p, k: nameKey(p.name), pub: publisherKey(p.publisher), loc: clean(p.location) }));
  const found = new Map(programs.map((p) => [p.key, []]));
  for (const root of fileRoots()) {
    for (const d of (await sys.readDir(root).catch(() => [])).filter((e) => e.dir && !e.link)) {
      const full = path.join(root, d.name);
      if (isProtected(full) || GENERIC.has(norm(d.name))) continue;
      const owner = keys.find((x) => nameMatches(d.name, x.k));
      if (owner) {
        found.get(owner.p.key).push(full);
        continue;
      }
      const pub = keys.filter((x) => x.pub && norm(d.name) === x.pub);
      if (pub.length) {
        for (const c of (await sys.readDir(full).catch(() => [])).filter((e) => e.dir && !e.link)) {
          const o = pub.find((x) => nameMatches(c.name, x.k));
          if (o) found.get(o.p.key).push(path.join(full, c.name));
        }
      }
    }
  }
  const out = [];
  for (const { p, loc } of keys) {
    const install = /^[a-z]:\\./i.test(loc) && !isProtected(loc) ? (await sys.folderSize(loc, 300000, 4000).catch(() => ({ bytes: 0 }))).bytes : 0;
    const dirs = [...new Set(found.get(p.key))].filter((d) => !(loc && under(d, loc)));
    const data = [];
    for (const d of dirs) data.push({ path: d, bytes: (await sys.folderSize(d, 300000, 3000).catch(() => ({ bytes: 0 }))).bytes });
    const fallback = install || (Number(p.sizeKB) || 0) * 1024;
    const total = fallback + data.reduce((n, x) => n + x.bytes, 0);
    if (total > 0) out.push({ key: p.key, name: p.name, install: fallback, data: data.filter((x) => x.bytes > 0).sort((a, b) => b.bytes - a.bytes), total });
  }
  return out.sort((a, b) => b.total - a.total);
}

// ---- change timeline ---------------------------------------------------------------------

// Everything Purgeon knows happened, newest first: [{ id, time, type, title, detail }].
export async function timeline(programs = [], written = {}) {
  const [h, s, m, a] = await Promise.all([history.list().catch(() => []), snapshots.list().catch(() => []), monitor.list().catch(() => []), archive.list().catch(() => [])]);
  const events = [
    ...h.map((e) => ({ id: `h${e.id}`, time: e.time, type: e.type, title: e.undone ? `${e.title} (undone)` : e.title, detail: e.detail || '' })),
    ...s.map((x) => ({ id: `s${x.id}`, time: x.created, type: 'Snapshot', title: `Snapshot "${x.name}"`, detail: x.preset })),
    ...m.map((x) => ({ id: `m${x.id}`, time: x.finished, type: 'Installed', title: `Installed ${x.name} (monitored)`, detail: `${x.items.length} recorded changes` })),
    ...a.map((x) => ({ id: `a${x.id}`, time: x.removed, type: 'Removed', title: `${x.how === 'outside' ? 'Removed outside Purgeon' : 'Removed'}: ${x.name}${x.version ? ` ${x.version}` : ''}`, detail: x.publisher })),
    // Windows records when each program's uninstall entry was last written: an install or an update.
    ...programs
      .filter((p) => written[p.key] || /^\d{4}-\d{2}-\d{2}$/.test(p.installDate || ''))
      .map((p) => ({ id: `w${p.key}`, time: written[p.key] ? new Date(written[p.key]).toISOString() : `${p.installDate}T12:00:00.000Z`, type: 'Windows', title: `Installed or updated: ${p.name}${p.version ? ` ${p.version}` : ''}`, detail: p.publisher || '' })),
  ];
  return events.filter((e) => e.time).sort((x, y) => y.time.localeCompare(x.time));
}

// ---- what a program does --------------------------------------------------------------------

const SECTIONS = [
  ['services', 'Services', (i) => i.kind === 'service'],
  ['tasks', 'Scheduled tasks', (i) => i.kind === 'task'],
  ['startup', 'Starts with Windows', (i) => i.kind === 'startup' || (i.kind === 'value' && /\\Run$/i.test(i.path))],
  ['firewall', 'Firewall rules', (i) => i.kind === 'firewall' || i.kind === 'inbound'],
  ['files', 'File types and links it opens', (i) => i.kind === 'key' && /file type|url handler|open with|protocol|associat/i.test(i.reason || '')],
  ['shell', 'Explorer menus and extensions', (i) => i.kind === 'key' && /shell|context|right-click|extension/i.test(i.reason || '')],
  ['folders', 'Folders and files', (i) => i.kind === 'dir' || i.kind === 'file'],
  ['registry', 'Other registry settings', (i) => i.kind === 'key' || i.kind === 'value'],
];

// Everything a program hooks into Windows, grouped: [{ id, label, items }].
export async function sheet(program) {
  const [items, entries, rules] = await Promise.all([scan(program).catch(() => []), startup.list().catch(() => []), inboundRules().catch(() => [])]);
  const loc = clean(program.location).toLowerCase();
  const inside = (cmd) => !!loc && String(cmd || '').toLowerCase().replace(/^"/, '').startsWith(loc + '\\');
  const extra = [
    ...entries.filter((e) => inside(e.command) && e.type !== 'service' && e.type !== 'task').map((e) => ({ kind: 'startup', path: e.name, reason: `${e.where}${e.enabled ? '' : ' (turned off)'}` })),
    ...rules.filter((r) => inside(r.program)).map((r) => ({ kind: 'inbound', path: r.display, reason: `Accepts incoming connections (${r.names.length} rule${r.names.length === 1 ? '' : 's'})` })),
  ];
  const all = [...items.filter((i) => i.score >= 70), ...extra];
  const used = new Set();
  return SECTIONS.map(([id, label, test]) => {
    const list = all.filter((i, n) => !used.has(n) && test(i) && used.add(n));
    return { id, label, items: list };
  }).filter((s) => s.items.length);
}

// ---- analyze a program -------------------------------------------------------------------

// When any of the program's executables last ran, from Windows' Prefetch records (readable with
// administrator rights only): { time } or { unknown: reason }.
async function lastRun(program, exe) {
  const loc = clean(program.location);
  const names = new Set();
  if (exe) names.add(path.basename(exe).toUpperCase());
  if (/^[a-z]:\\./i.test(loc)) for (const e of (await sys.readDir(loc).catch(() => [])).filter((x) => x.file && /\.exe$/i.test(x.name))) names.add(e.name.toUpperCase());
  if (!names.size) return { unknown: 'No program file was found to look for.' };
  const pf = path.join(sys.info.env?.SystemRoot || 'C:\\Windows', 'Prefetch');
  const files = await sys.readDir(pf).catch(() => null);
  if (!files) return { unknown: 'Windows keeps this in its Prefetch folder, which needs administrator rights to read.' };
  let latest = 0;
  for (const f of files.filter((x) => x.file && names.has(x.name.replace(/-[0-9A-F]{8}\.pf$/i, '').toUpperCase()))) {
    const s = await sys.stat(path.join(pf, f.name)).catch(() => null);
    if (s?.modified > latest) latest = s.modified;
  }
  return latest ? { time: new Date(latest).toISOString() } : { unknown: 'Windows has no record of it running recently (Prefetch keeps the last few hundred programs).' };
}

// One page about a program, from what Purgeon already knows how to find: how it was
// installed and can be removed, its disk use, what it hooks into Windows, whether it runs now,
// when it last ran, what depends on it, and the processor it is built for. Read-only.
export async function analyze(program) {
  const loc = clean(program.location);
  const exe = await programExe(program).catch(() => null);
  const [space, sections, installer, deps, running, used, arch] = await Promise.all([
    diskMap([program])
      .then((d) => d[0] || null)
      .catch(() => null),
    sheet(program).catch(() => []),
    installers.describe(program).catch(() => ({})),
    dependencyInfo(program).catch(() => ({})),
    /^[a-z]:\\./i.test(loc) ? processesIn(loc).catch(() => []) : [],
    lastRun(program, exe).catch(() => ({ unknown: 'Could not be read.' })),
    exe && sys.exeArch ? sys.exeArch([exe]).then((a) => a[0] || '', () => '') : '',
  ]);
  return {
    exe,
    arch,
    installer: { label: installer.label || 'Unknown installer', silent: !!installer.silent, uninstaller: !!program.uninstall },
    space,
    hooks: sections.map((s) => ({ id: s.id, label: s.label, count: s.items.length, items: s.items.slice(0, 8).map((i) => `${i.path}${i.name ? ` › ${i.name}` : ''}`) })),
    running: running.map((r) => ({ name: r.ProcessName, path: r.Path })),
    lastUsed: used,
    dependencies: { kind: deps.kind || null, dependents: deps.dependents || [], note: deps.note || '' },
  };
}

// ---- registry search ---------------------------------------------------------------------

const SEARCH = `
$in = [Console]::In.ReadToEnd() | ConvertFrom-Json
$term = [string]$in.term; $max = [int]$in.max
$sw = [Diagnostics.Stopwatch]::StartNew(); $res = New-Object System.Collections.ArrayList
function Walk($key, $name, $depth) {
  if ($sw.ElapsedMilliseconds -gt 25000 -or $res.Count -ge $max -or $depth -gt 12) { return }
  try { $k = $key.OpenSubKey($name, $false) } catch { return }
  if (-not $k) { return }
  try {
    if ($k.Name.Split('\\')[-1].IndexOf($term, [StringComparison]::OrdinalIgnoreCase) -ge 0) { [void]$res.Add([pscustomobject]@{ kind = 'key'; path = $k.Name; name = '' }) }
    else {
      foreach ($v in $k.GetValueNames()) {
        $d = $k.GetValue($v, $null, 'DoNotExpandEnvironmentNames')
        if (($v -and $v.IndexOf($term, [StringComparison]::OrdinalIgnoreCase) -ge 0) -or ($d -is [string] -and $d.IndexOf($term, [StringComparison]::OrdinalIgnoreCase) -ge 0)) { [void]$res.Add([pscustomobject]@{ kind = 'value'; path = $k.Name; name = $v; data = [string]$d }) }
      }
    }
    foreach ($s in $k.GetSubKeyNames()) { if ($depth -eq 0 -and $s -eq 'Classes') { continue }; Walk $k $s ($depth + 1) }
  } finally { $k.Close() }
}
foreach ($root in @(@([Microsoft.Win32.Registry]::CurrentUser, 'Software'), @([Microsoft.Win32.Registry]::LocalMachine, 'SOFTWARE'))) { Walk $root[0] $root[1] 0 }
[pscustomobject]@{ results = @($res); timedOut = ($sw.ElapsedMilliseconds -gt 25000); full = ($res.Count -ge $max) } | ConvertTo-Json -Compress -Depth 4
`;

// Registry keys named after, and values mentioning, a term (Software branches; Classes left out
// for speed). Results go through the same protection rules as leftovers and start unticked.
export async function searchRegistry(term, max = 400) {
  const t = String(term || '').trim();
  if (t.length < 3) throw new Error('Type at least three characters.');
  // The Rust core walks the registry directly; the PowerShell version is the fallback (tests).
  const out = sys.searchRegistry ? await sys.searchRegistry(t, max, 20000) : (await runPSJson(SEARCH, { input: JSON.stringify({ term: t, max }) }))[0];
  const items = (out?.results || []).map((r) => ({ kind: r.kind, path: r.path, ...(r.kind === 'value' && { name: r.name }), score: 40, reason: r.kind === 'key' ? `Key named after "${t}"` : `Value mentions "${t}"${r.data ? `: ${String(r.data).slice(0, 80)}` : ''}` }));
  return { items: merge(items), timedOut: !!out?.timedOut, full: !!out?.full };
}
