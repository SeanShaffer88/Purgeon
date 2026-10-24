// Program backup and transfer: packs a program's folders, files and registry settings into one
// .swpkg file (a zip with a manifest), and restores it on this or another PC.
//
// Restoring is careful:
// - paths in the old user profile are moved to this PC's profile, and the old user's registry
//   hive to HKEY_CURRENT_USER;
// - existing folders and files are never overwritten: those items are skipped;
// - an existing registry key is exported before the backup is imported over it;
// - everything restored is recorded, so the restore can be undone from Change History.
// Services, scheduled tasks and drivers are not included; reinstall a program that needs them.
import { sys, homeDir } from './sys.js';
import * as path from './winpath.js';
import { runPS, runPSJson, reg, psq } from './shell.js';
import { isProtected, isProtectedKey } from './paths.js';

let root = '';
export const setRoot = async (dir) => {
  root = dir;
  await sys.makeDir(root);
};

const FORMAT = 'sweepuninstall-program-backup';

const EXPORT = `
$ErrorActionPreference = 'Stop'
$in = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
if (Test-Path -LiteralPath $in.file) { Remove-Item -LiteralPath $in.file -Force }
$zip = [IO.Compression.ZipFile]::Open($in.file, 'Create')
$items = New-Object System.Collections.ArrayList
$tmp = Join-Path $env:TEMP ('swpkg-' + [guid]::NewGuid())
New-Item -ItemType Directory $tmp | Out-Null
try {
  $n = 0
  foreach ($i in $in.items) {
    $rec = [ordered]@{ n = $n; kind = $i.kind; path = $i.path }
    if ($i.kind -eq 'dir' -or $i.kind -eq 'file') {
      $files = 0; $skipped = 0; $bytes = [long]0
      $list = if ($i.kind -eq 'dir') { @(Get-ChildItem -LiteralPath $i.path -Recurse -File -Force -ErrorAction SilentlyContinue | Where-Object { -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) }) } else { @(Get-Item -LiteralPath $i.path -Force -ErrorAction SilentlyContinue) }
      foreach ($f in $list) {
        $rel = if ($i.kind -eq 'dir') { $f.FullName.Substring($i.path.TrimEnd('\\').Length).TrimStart('\\') } else { $f.Name }
        try { [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $f.FullName, ('files/' + $n + '/' + $rel.Replace('\\', '/')), 'Optimal'); $files++; $bytes += $f.Length } catch { $skipped++ }
      }
      if ($i.kind -eq 'dir') { foreach ($d in Get-ChildItem -LiteralPath $i.path -Recurse -Directory -Force -ErrorAction SilentlyContinue) { if (-not (Get-ChildItem -LiteralPath $d.FullName -Force -ErrorAction SilentlyContinue)) { [void]$zip.CreateEntry('files/' + $n + '/' + $d.FullName.Substring($i.path.TrimEnd('\\').Length).TrimStart('\\').Replace('\\', '/') + '/') } } }
      $rec.files = $files; $rec.skipped = $skipped; $rec.bytes = $bytes
    } elseif ($i.kind -eq 'key') {
      $f = Join-Path $tmp "$n.reg"
      & reg.exe export $i.path $f /y 2>$null | Out-Null
      if ($LASTEXITCODE -ne 0) { continue }
      [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $f, "registry/$n.reg", 'Optimal')
    } elseif ($i.kind -eq 'value') {
      $k = Get-Item -LiteralPath "Registry::$($i.path)" -ErrorAction SilentlyContinue
      if (-not $k -or $k.GetValueNames() -notcontains $i.name) { continue }
      $data = $k.GetValue($i.name, $null, 'DoNotExpandEnvironmentNames')
      $rec.name = $i.name; $rec.valueKind = [string]$k.GetValueKind($i.name)
      $rec.data = if ($data -is [byte[]]) { ($data | ForEach-Object { $_.ToString('x2') }) -join '' } elseif ($data -is [string[]]) { $data -join '\\0' } else { [string]$data }
    } else { continue }
    [void]$items.Add([pscustomobject]$rec); $n++
  }
  $manifest = [ordered]@{ format = '${FORMAT}'; version = 1; created = (Get-Date).ToUniversalTime().ToString('o'); program = $in.program
    source = [ordered]@{ computer = $env:COMPUTERNAME; user = $env:USERNAME; profile = $env:USERPROFILE; sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value }
    items = @($items) }
  $e = $zip.CreateEntry('manifest.json')
  $w = New-Object IO.StreamWriter($e.Open(), (New-Object Text.UTF8Encoding($false)))
  $w.Write(($manifest | ConvertTo-Json -Depth 6)); $w.Close()
} finally { $zip.Dispose(); Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
[pscustomobject]@{ file = $in.file; items = @($items) } | ConvertTo-Json -Compress -Depth 5
`;

// Writes a backup of the chosen items (dir, file, key, value) to `file`.
export async function exportProgram(program, items, file) {
  if (!/\.swpkg$/i.test(file)) throw new Error('The backup file must end in .swpkg');
  const wanted = items.filter((i) => ['dir', 'file', 'key', 'value'].includes(i.kind));
  const [out] = await runPSJson(EXPORT, {
    input: JSON.stringify({ file, program: { name: program.name, version: program.version || '', publisher: program.publisher || '', key: program.key || '' }, items: wanted.map((i) => ({ kind: i.kind, path: i.path, name: i.name || '' })) }),
  });
  return out;
}

const READ_MANIFEST = `
$f = [Console]::In.ReadToEnd().Trim()
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($f)
try {
  $e = $zip.GetEntry('manifest.json'); if (-not $e) { throw 'This file is not a SweepUninstall program backup.' }
  $r = New-Object IO.StreamReader($e.Open()); $r.ReadToEnd(); $r.Close()
} finally { $zip.Dispose() }
`;

// Where a backed-up path or key goes on this PC: the old profile becomes this profile, and the
// old user's registry hive becomes HKEY_CURRENT_USER.
export function mapTarget(item, source, here = { profile: homeDir(), sid: '' }) {
  if (item.kind === 'key' || item.kind === 'value') {
    let k = item.path;
    if (source.sid) k = k.replace(new RegExp(`^HKEY_USERS\\\\${source.sid.replace(/[-]/g, '\\-')}(_Classes)?(?=\\\\|$)`, 'i'), (_, classes) => (classes ? 'HKEY_CURRENT_USER\\Software\\Classes' : 'HKEY_CURRENT_USER'));
    return k;
  }
  const from = String(source.profile || '').replace(/\\+$/, '');
  if (from && item.path.toLowerCase().startsWith(from.toLowerCase() + '\\')) return here.profile.replace(/\\+$/, '') + item.path.slice(from.length);
  return item.path;
}

// Rewrites a .reg export for this PC: old profile paths (written with doubled backslashes inside
// strings) and the old user's hive.
export function rewriteReg(text, source, here = { profile: homeDir() }) {
  let t = text;
  const from = String(source.profile || '').replace(/\\+$/, '');
  const to = here.profile.replace(/\\+$/, '');
  if (from && from.toLowerCase() !== to.toLowerCase()) {
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    t = t.replace(new RegExp(esc(from.replace(/\\/g, '\\\\')), 'gi'), to.replace(/\\/g, '\\\\'));
    t = t.replace(new RegExp(esc(from), 'gi'), to);
  }
  if (source.sid) t = t.replace(new RegExp(`\\[HKEY_USERS\\\\${source.sid}(_Classes)?`, 'gi'), (_, classes) => (classes ? '[HKEY_CURRENT_USER\\Software\\Classes' : '[HKEY_CURRENT_USER'));
  return t;
}

// The backup's manifest, with each item's target on this PC and whether it can be restored.
export async function read(file) {
  const manifest = JSON.parse((await runPS(READ_MANIFEST, { input: file })).replace(/^\uFEFF/, ''));
  if (manifest.format !== FORMAT) throw new Error('This file is not a SweepUninstall program backup.');
  const items = [];
  for (const i of manifest.items) {
    const target = mapTarget(i, manifest.source);
    let blocked = '';
    if (i.kind === 'dir' || i.kind === 'file') {
      if (isProtected(target)) blocked = 'Protected location';
      else if (!(await sys.exists(target.slice(0, 3)))) blocked = `Drive ${target.slice(0, 2)} is not on this PC`;
      else if (await sys.exists(target)) blocked = 'Already exists here, left as it is';
    } else if (i.kind === 'key' && isProtectedKey(target)) blocked = 'Protected Windows key';
    items.push({ ...i, target, blocked });
  }
  return { ...manifest, file, items };
}

const EXTRACT = `
$ErrorActionPreference = 'Stop'
$in = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($in.file)
$res = @{}
try {
  foreach ($i in $in.items) {
    $prefix = "files/$($i.n)/"; $count = 0
    if (Test-Path -LiteralPath $i.target) { $res["$($i.n)"] = 'EXISTS'; continue }
    foreach ($e in $zip.Entries) {
      if (-not $e.FullName.StartsWith($prefix)) { continue }
      $rel = $e.FullName.Substring($prefix.Length).Replace('/', '\\')
      if ($rel -match '(^|\\\\)\\.\\.(\\\\|$)') { continue }
      $dest = if ($i.kind -eq 'file') { $i.target } else { Join-Path $i.target $rel }
      if ($e.FullName.EndsWith('/')) { New-Item -ItemType Directory -Path $dest -Force | Out-Null; continue }
      New-Item -ItemType Directory -Path (Split-Path -Parent $dest) -Force | Out-Null
      [IO.Compression.ZipFileExtensions]::ExtractToFile($e, $dest, $false); $count++
    }
    if ($i.kind -eq 'dir' -and -not (Test-Path -LiteralPath $i.target)) { New-Item -ItemType Directory -Path $i.target -Force | Out-Null }
    $res["$($i.n)"] = "OK $count"
  }
  foreach ($i in $in.keys) {
    $e = $zip.GetEntry("registry/$($i.n).reg"); if (-not $e) { continue }
    $r = New-Object IO.StreamReader($e.Open(), $true); $res["reg$($i.n)"] = $r.ReadToEnd(); $r.Close()
  }
} finally { $zip.Dispose() }
$res | ConvertTo-Json -Compress
`;

const REG_TYPE = { String: 'REG_SZ', ExpandString: 'REG_EXPAND_SZ', DWord: 'REG_DWORD', QWord: 'REG_QWORD', Binary: 'REG_BINARY', MultiString: 'REG_MULTI_SZ' };

// Restores the chosen items (by number) of a backup read with read(). Returns { id, results }.
export async function restore(file, numbers) {
  const backup = await read(file);
  const chosen = backup.items.filter((i) => numbers.includes(i.n) && !i.blocked);
  const id = String(Date.now());
  const dir = path.join(root, id);
  await sys.makeDir(dir);
  const record = { id, name: backup.program.name, file, created: new Date().toISOString(), dirs: [], files: [], keys: [], values: [] };
  const results = backup.items.filter((i) => numbers.includes(i.n) && i.blocked).map((i) => ({ kind: i.kind, path: i.target, name: i.name, ok: false, detail: i.blocked }));

  const fileItems = chosen.filter((i) => i.kind === 'dir' || i.kind === 'file');
  const keyItems = chosen.filter((i) => i.kind === 'key');
  const out = await runPSJson(EXTRACT, { input: JSON.stringify({ file, items: fileItems.map((i) => ({ n: i.n, kind: i.kind, target: i.target })), keys: keyItems.map((i) => ({ n: i.n })) }) }).then((r) => r[0] || {});
  for (const i of fileItems) {
    const r = String(out[i.n] || 'Not restored');
    const ok = r.startsWith('OK');
    if (ok) record[i.kind === 'dir' ? 'dirs' : 'files'].push(i.target);
    results.push({ kind: i.kind, path: i.target, ok, detail: ok ? (i.kind === 'dir' ? `Restored ${r.slice(3)} files` : 'Restored') : r === 'EXISTS' ? 'Already exists here, left as it is' : r });
  }

  let k = 0;
  for (const i of keyItems) {
    const text = out[`reg${i.n}`];
    if (!text) {
      results.push({ kind: 'key', path: i.target, ok: false, detail: 'Missing from the backup file' });
      continue;
    }
    // An existing key is exported first, so undo can put it back exactly.
    const before = path.join(dir, `before-${++k}.reg`);
    const existed = (await reg(['export', i.target, before, '/y'])).ok;
    const regFile = path.join(dir, `restore-${k}.reg`);
    // reg.exe imports UTF-16 files only.
    await runPS(`[IO.File]::WriteAllText(${psq(regFile)}, [Console]::In.ReadToEnd(), [Text.Encoding]::Unicode)`, { input: rewriteReg(text.replace(/^\uFEFF/, ''), backup.source) });
    const r = await reg(['import', regFile]);
    if (r.ok) record.keys.push({ path: i.target, before: existed ? path.basename(before) : null });
    results.push({ kind: 'key', path: i.target, ok: r.ok, detail: r.ok ? (existed ? 'Merged into the existing key (its earlier contents were saved)' : 'Restored') : r.stderr });
  }

  for (const i of chosen.filter((x) => x.kind === 'value')) {
    const old = await runPSJson(
      `$k = Get-Item -LiteralPath ${psq(`Registry::${i.target}`)} -ErrorAction SilentlyContinue
       $n = ${psq(i.name)}
       if ($k -and $k.GetValueNames() -contains $n) {
         $d = $k.GetValue($n, $null, 'DoNotExpandEnvironmentNames')
         [pscustomobject]@{ kind = [string]$k.GetValueKind($n); data = if ($d -is [byte[]]) { ($d | ForEach-Object { $_.ToString('x2') }) -join '' } elseif ($d -is [string[]]) { $d -join '\\0' } else { [string]$d } } | ConvertTo-Json -Compress
       }`
    ).catch(() => []);
    const data = rewriteReg(String(i.data), backup.source);
    const r = await reg(['add', i.target, ...(i.name ? ['/v', i.name] : ['/ve']), '/t', REG_TYPE[i.valueKind] || 'REG_SZ', '/d', data, '/f']);
    if (r.ok) record.values.push({ path: i.target, name: i.name, old: old[0] || null });
    results.push({ kind: 'value', path: i.target, name: i.name, ok: r.ok, detail: r.ok ? 'Restored' : r.stderr });
  }

  await sys.writeText(path.join(dir, 'restore.json'), JSON.stringify(record, null, 2));
  return { id, name: record.name, results };
}

// Undoes a restore: restored folders and files go to the Recycle Bin, restored keys are deleted
// (and earlier contents re-imported), and values are put back or removed.
export async function undo(id) {
  if (!/^\d+$/.test(String(id))) throw new Error('Invalid restore id');
  const dir = path.join(root, String(id));
  const record = JSON.parse(await sys.readText(path.join(dir, 'restore.json')));
  const results = [];
  for (const p of [...record.dirs, ...record.files]) {
    if (isProtected(p)) {
      results.push({ kind: 'dir', path: p, ok: false, detail: 'Protected location, left in place' });
      continue;
    }
    try {
      if (await sys.exists(p)) await sys.trash(p);
      results.push({ kind: 'dir', path: p, ok: true, detail: 'Moved to Recycle Bin' });
    } catch (e) {
      results.push({ kind: 'dir', path: p, ok: false, detail: String(e?.message || e) });
    }
  }
  for (const k of record.keys) {
    if (isProtectedKey(k.path)) {
      results.push({ kind: 'key', path: k.path, ok: false, detail: 'Protected Windows key, left in place' });
      continue;
    }
    await reg(['delete', k.path, '/f']);
    const r = k.before ? await reg(['import', path.join(dir, k.before)]) : { ok: true };
    results.push({ kind: 'key', path: k.path, ok: r.ok, detail: r.ok ? (k.before ? 'Earlier contents put back' : 'Removed') : r.stderr });
  }
  for (const v of record.values) {
    const r = v.old
      ? await reg(['add', v.path, ...(v.name ? ['/v', v.name] : ['/ve']), '/t', REG_TYPE[v.old.kind] || 'REG_SZ', '/d', v.old.data, '/f'])
      : await reg(['delete', v.path, ...(v.name ? ['/v', v.name] : ['/ve']), '/f']);
    results.push({ kind: 'value', path: v.path, name: v.name, ok: r.ok || /unable to find/i.test(r.stderr), detail: v.old ? 'Earlier value put back' : 'Removed' });
  }
  return results;
}

// Items a program backup offers by default: what the leftover scan is sure about, minus things
// that can't be carried to another PC (services, tasks, firewall rules).
export const backupCandidates = (scanItems) => scanItems.filter((i) => ['dir', 'file', 'key', 'value'].includes(i.kind));

export const defaultFileName = (program) => `${String(program.name).replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'program'}${program.version ? ` ${program.version}` : ''}.swpkg`;
