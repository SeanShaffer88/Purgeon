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
import { sys, homeDir, env } from './sys.js';
import * as path from './winpath.js';
import { runPS, runPSJson, reg, psq } from './shell.js';
import { isProtected, isProtectedKey } from './paths.js';
import { detect } from './installers.js';
import { restoreManyFromRecycleBin } from './backups.js';
import { validateTarget, validateRegistryText } from './import-policy.js';

let root = '';
export const setRoot = async (dir) => {
  root = dir;
  await sys.makeDir(root);
};

const FORMAT = 'purgeon-program-backup';

const EXPORT = `
$ErrorActionPreference = 'Stop'
$in = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
# CreateNew never truncates either a prior package or another writer's staging file.
$stream = [IO.File]::Open($in.stage, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
$owned = $true
$zip = $null
$success = $false
$items = New-Object System.Collections.ArrayList
$tmp = Join-Path $env:TEMP ('swpkg-' + [guid]::NewGuid())
try {
  New-Item -ItemType Directory $tmp -ErrorAction Stop | Out-Null
  $zip = New-Object IO.Compression.ZipArchive($stream, [IO.Compression.ZipArchiveMode]::Create, $true)
  $excludedOutput = @([string]$in.file, [string]$in.stage, [string](Get-Item -LiteralPath $in.stage -Force -ErrorAction Stop).FullName)
  if (Test-Path -LiteralPath $in.file) { $excludedOutput += [string](Get-Item -LiteralPath $in.file -Force -ErrorAction Stop).FullName }
  $n = 0
  foreach ($i in $in.items) {
    $rec = [ordered]@{ n = $n; kind = $i.kind; path = $i.path }
    if ($i.kind -eq 'dir' -or $i.kind -eq 'file') {
      $files = 0; $skipped = 0; $bytes = [long]0
      $sourceRoot = if ($i.kind -eq 'dir') { (Get-Item -LiteralPath $i.path -Force -ErrorAction Stop).FullName.TrimEnd('\\') } else { '' }
      $list = if ($i.kind -eq 'dir') { @(Get-ChildItem -LiteralPath $i.path -Recurse -File -Force -ErrorAction SilentlyContinue | Where-Object { -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -and $_.FullName -notin $excludedOutput }) } else { @(Get-Item -LiteralPath $i.path -Force -ErrorAction SilentlyContinue) }
      foreach ($f in $list) {
        if ($f.FullName -in $excludedOutput) { continue }
        $rel = if ($i.kind -eq 'dir') { $f.FullName.Substring($sourceRoot.Length).TrimStart('\\') } else { $f.Name }
        try { [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $f.FullName, ('files/' + $n + '/' + $rel.Replace('\\', '/')), 'Optimal'); $files++; $bytes += $f.Length } catch { $skipped++ }
      }
      if ($i.kind -eq 'dir') { foreach ($d in Get-ChildItem -LiteralPath $i.path -Recurse -Directory -Force -ErrorAction SilentlyContinue) { if (-not (Get-ChildItem -LiteralPath $d.FullName -Force -ErrorAction SilentlyContinue)) { [void]$zip.CreateEntry('files/' + $n + '/' + $d.FullName.Substring($sourceRoot.Length).TrimStart('\\').Replace('\\', '/') + '/') } } }
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
  $zip.Dispose(); $zip = $null
  $stream.Flush($true); $stream.Dispose(); $stream = $null
  # Close and read back the entire ZIP before handing it to atomic publication.
  $check = [IO.Compression.ZipFile]::OpenRead($in.stage)
  try {
    $seen = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in $check.Entries) {
      if (-not $seen.Add($entry.FullName)) { throw 'Duplicate package entry' }
      $reader = $entry.Open()
      try { $reader.CopyTo([IO.Stream]::Null) } finally { $reader.Dispose() }
    }
    $manifestEntry = $check.GetEntry('manifest.json')
    if (-not $manifestEntry) { throw 'Package manifest missing after export' }
    $reader = New-Object IO.StreamReader($manifestEntry.Open())
    try { $verified = $reader.ReadToEnd() | ConvertFrom-Json -ErrorAction Stop } finally { $reader.Dispose() }
    if ($verified.format -cne '${FORMAT}' -or $verified.version -ne 1 -or @($verified.items).Count -ne $items.Count) { throw 'Package readback did not match export' }
  } finally { $check.Dispose() }
  $success = $true
} finally {
  if ($zip) { $zip.Dispose() }
  if ($stream) { $stream.Dispose() }
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  if ($owned -and -not $success) { Remove-Item -LiteralPath $in.stage -Force -ErrorAction SilentlyContinue }
}
[pscustomobject]@{ file = $in.file; stage = $in.stage; items = @($items) } | ConvertTo-Json -Compress -Depth 5
`;

// Migration splits a program into its program part and the user's own settings, so it can be
// moved with or without them. Settings: anything in the user profile except installed programs
// (AppData\Local\Programs) and shortcuts, and per-user registry except the uninstall entry.
export function isSettings(item, profile = homeDir(), local = env('LOCALAPPDATA')) {
  if (item.kind === 'key' || item.kind === 'value') return /^HKEY_CURRENT_USER\\/i.test(item.path) && !/\\CurrentVersion\\Uninstall\\/i.test(item.path);
  const p = item.path.toLowerCase();
  const inside = (root) => !!root && (p === root.toLowerCase() || p.startsWith(root.toLowerCase().replace(/\\+$/, '') + '\\'));
  if (!inside(profile)) return false;
  if (local && inside(path.join(local, 'Programs'))) return false;
  if (/\.(lnk|url)$/i.test(p) || /\\start menu\\/i.test(p) || /\\desktop(\\|$)/i.test(p)) return false;
  return true;
}

// Writes a backup of the chosen items (dir, file, key, value) to `file`. `contents` says what the
// package holds: 'all' (program and settings), 'program' or 'settings'.
export async function exportProgram(program, items, file, contents = 'all') {
  if (!/\.swpkg$/i.test(file)) throw new Error('The backup file must end in .swpkg');
  const wanted = items.filter((i) => ['dir', 'file', 'key', 'value'].includes(i.kind) && (contents === 'all' || (contents === 'settings') === isSettings(i)));
  const finalFile = path.resolve(file);
  const stage = path.join(path.dirname(finalFile), `.purgeon-export-${globalThis.crypto.randomUUID()}.tmp`);
  const [out] = await runPSJson(EXPORT, {
    input: JSON.stringify({ file: finalFile, stage, program: { name: program.name, version: program.version || '', publisher: program.publisher || '', key: program.key || '', installer: detect(program).type, contents }, items: wanted.map((i) => ({ kind: i.kind, path: i.path, name: i.name || '' })) }),
  });
  if (!out || out.stage !== stage || out.file !== finalFile || !Array.isArray(out.items)) throw new Error('Export did not return the expected staged package');
  try {
    await sys.commitStagedFile(stage, finalFile);
  } catch (error) {
    throw new Error(`The new package could not replace the destination; the previous package was retained: ${error.message}. Temporary export retained at ${stage}; inspect or remove this file after resolving the failure.`);
  }
  return { file: finalFile, items: out.items };
}

const READ_MANIFEST = `
$f = [Console]::In.ReadToEnd().Trim()
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($f)
try {
  $e = $zip.GetEntry('manifest.json'); if (-not $e) { throw 'This file is not a Purgeon program backup.' }
  if ($zip.Entries.Count -gt 100000 -or $e.Length -gt 1048576) { throw 'Package manifest exceeds safety limits' }
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
// With `replace`, existing settings folders in your profile are not blocked: a restore moves them
// to the Recycle Bin first (settings sync).
export async function read(file, { replace = false } = {}) {
  const manifest = JSON.parse((await runPS(READ_MANIFEST, { input: file })).replace(/^\uFEFF/, ''));
  if (manifest.format !== FORMAT || manifest.version !== 1 || !manifest.source || !manifest.program || typeof manifest.program.name !== 'string' || !Array.isArray(manifest.items) || manifest.items.length > 10000) throw new Error('Invalid or unsupported program backup.');
  if (manifest.source.sid && !/^S-\d+(?:-\d+)+$/.test(manifest.source.sid)) throw new Error('Invalid source SID');
  const ids = new Set();
  const items = [];
  for (const i of manifest.items) {
    if (!Number.isSafeInteger(i.n) || i.n < 0 || ids.has(i.n) || typeof i.path !== 'string') throw new Error('Invalid or duplicate package item');
    ids.add(i.n);
    const target = mapTarget(i, manifest.source);
    let blocked = '';
    try { validateTarget(target, i.kind); } catch (e) { blocked = e.message; }
    if (!blocked && (i.kind === 'dir' || i.kind === 'file')) {
      if (isProtected(target)) blocked = 'Protected location';
      else if (!(await sys.exists(target.slice(0, 3)))) blocked = `Drive ${target.slice(0, 2)} is not on this PC`;
      else if (await sys.exists(target)) blocked = replace && isSettings({ kind: i.kind, path: target }) ? '' : 'Already exists here, left as it is';
    } else if (['key', 'value'].includes(i.kind) && isProtectedKey(target)) blocked = 'Protected Windows key';
    items.push({ ...i, target, blocked });
  }
  return { ...manifest, file, items };
}

const EXTRACT = String.raw`
$ErrorActionPreference = 'Stop'
$in = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($in.file)
$res = @{}
try {
  if ($zip.Entries.Count -gt 100000) { throw 'Archive entry count exceeds limit' }
  $total = [long]0
  foreach ($entry in $zip.Entries) {
    $total += $entry.Length
    if ($total -gt 4294967296 -or $entry.Length -gt 1073741824 -or ($entry.Length -gt 1048576 -and $entry.Length -gt [Math]::Max(1, $entry.CompressedLength) * 1000)) { throw 'Archive expansion exceeds safety limits' }
  }
  $plan = New-Object System.Collections.ArrayList
  $destinations = @{}
  foreach ($i in $in.items) {
    $prefix = "files/$($i.n)/"
    $base = [IO.Path]::GetFullPath($i.target).TrimEnd('\')
    $matches = @($zip.Entries | Where-Object { $_.FullName.StartsWith($prefix, [StringComparison]::Ordinal) })
    if ($i.kind -eq 'file' -and @($matches | Where-Object { -not $_.FullName.EndsWith('/') }).Count -ne 1) { throw 'File item must contain exactly one file' }
    foreach ($entry in $matches) {
      $rel = $entry.FullName.Substring($prefix.Length).Replace('/', '\')
      $segments = $rel.TrimEnd('\').Split('\')
      if ([IO.Path]::IsPathRooted($rel) -or $rel.Contains(':') -or $rel.IndexOf([char]0) -ge 0) { throw 'Unsafe archive destination' }
      foreach ($segment in $segments) {
        if (-not $segment -or $segment -in '.', '..' -or $segment -match '[. ]$|[<>:"|?*]' -or $segment -match '^(?i:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)') { throw 'Archive contains a Windows path alias' }
      }
      $dest = if ($i.kind -eq 'file') { $base } else { [IO.Path]::GetFullPath((Join-Path $base $rel)) }
      if ($dest -ne $base -and -not $dest.StartsWith($base + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Archive path escapes approved folder' }
      $key = $dest.ToLowerInvariant()
      if ($destinations.ContainsKey($key)) { throw 'Archive contains duplicate destinations' }
      $destinations[$key] = $true
      $parent = $dest
      while ($parent) {
        if (Test-Path -LiteralPath $parent) { if ((Get-Item -LiteralPath $parent -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse point in destination' } }
        $parent = Split-Path -Parent $parent
      }
      [void]$plan.Add([pscustomobject]@{ entry = $entry; dest = $dest; n = $i.n; directory = $entry.FullName.EndsWith('/') })
    }
  }
  foreach ($i in $in.keys) {
    $entry = $zip.GetEntry("registry/$($i.n).reg")
    if (-not $entry -or $entry.Length -gt 8388608) { throw 'Missing or oversized registry payload' }
    $reader = New-Object IO.StreamReader($entry.Open(), $true)
    try { $res["reg$($i.n)"] = $reader.ReadToEnd() } finally { $reader.Dispose() }
  }
  if ($in.preflight) { $res | ConvertTo-Json -Compress; return }
  foreach ($i in $in.items) {
    if (Test-Path -LiteralPath $i.target) { $res["$($i.n)"] = 'EXISTS'; continue }
    $count = 0
    foreach ($step in @($plan | Where-Object { $_.n -eq $i.n })) {
      $parent = Split-Path -Parent $step.dest
      while ($parent) {
        if (Test-Path -LiteralPath $parent) { if ((Get-Item -LiteralPath $parent -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Destination changed to a reparse point' } }
        $parent = Split-Path -Parent $parent
      }
      if ($step.directory) { New-Item -ItemType Directory -Path $step.dest -Force | Out-Null }
      else {
        New-Item -ItemType Directory -Path (Split-Path -Parent $step.dest) -Force | Out-Null
        [IO.Compression.ZipFileExtensions]::ExtractToFile($step.entry, $step.dest, $false)
        $count++
      }
    }
    if ($i.kind -eq 'dir' -and -not (Test-Path -LiteralPath $i.target)) { New-Item -ItemType Directory -Path $i.target | Out-Null }
    $res["$($i.n)"] = "OK $count"
  }
  $res | ConvertTo-Json -Compress
} finally { $zip.Dispose() }
`;

const REG_TYPE = { String: 'REG_SZ', ExpandString: 'REG_EXPAND_SZ', DWord: 'REG_DWORD', QWord: 'REG_QWORD', Binary: 'REG_BINARY', MultiString: 'REG_MULTI_SZ' };

// Restores the chosen items (by number) of a backup read with read(). Returns { id, results }.
export async function restore(file, numbers, { replace = false } = {}) {
  const backup = await read(file, { replace });
  const chosen = backup.items.filter((i) => numbers.includes(i.n) && !i.blocked);
  // Validate all registry contents before any file replacement or registry write.
  const registryOut = (await runPSJson(EXTRACT, { input: JSON.stringify({ file, preflight: true, items: chosen.filter((i) => ['file', 'dir'].includes(i.kind)).map(({ n, kind, target }) => ({ n, kind, target })), keys: chosen.filter((i) => i.kind === 'key').map(({ n }) => ({ n })) }) }))[0] || {};
  for (const i of chosen.filter((i) => i.kind === 'key')) validateRegistryText(rewriteReg(registryOut[`reg${i.n}`] || '', backup.source), i.target);
  const id = String(Date.now());
  const dir = path.join(root, id);
  await sys.makeDir(dir);
  const record = { id, name: backup.program.name, file, created: new Date().toISOString(), dirs: [], files: [], keys: [], values: [], replaced: [] };
  record.complete = false;
  record.pending = chosen.map((i) => ({ kind: i.kind, target: i.target, n: i.n }));
  const checkpoint = () => sys.writeTextAtomic(path.join(dir, 'restore.json'), JSON.stringify(record, null, 2));
  await checkpoint();
  const results = backup.items.filter((i) => numbers.includes(i.n) && i.blocked).map((i) => ({ kind: i.kind, path: i.target, name: i.name, ok: false, detail: i.blocked }));

  const fileItems = chosen.filter((i) => i.kind === 'dir' || i.kind === 'file');
  // Settings being replaced go to the Recycle Bin first, so undo can bring them back.
  for (const i of fileItems.filter((x) => replace && isSettings({ kind: x.kind, path: x.target }))) {
    if (!(await sys.exists(i.target))) continue;
    try {
      record.inFlight = { kind: 'replace', target: i.target };
      await checkpoint();
      await sys.trash(i.target);
      record.replaced.push(i.target);
      delete record.inFlight;
      await checkpoint();
    } catch (e) {
      throw new Error(`Replacement did not complete. The recovery journal is retained: ${e?.message || e}`);
    }
  }
  const keyItems = chosen.filter((i) => i.kind === 'key');
  record.inFlight = { kind: 'extract', targets: fileItems.map(({ kind, target }) => ({ kind, target })) };
  await checkpoint();
  const out = { ...registryOut, ...(await runPSJson(EXTRACT, { input: JSON.stringify({ file, items: fileItems.filter((i) => !i.skip).map((i) => ({ n: i.n, kind: i.kind, target: i.target })), keys: [] }) }).then((r) => r[0] || {})) };
  for (const i of fileItems.filter((x) => !x.skip)) {
    const r = String(out[i.n] || 'Not restored');
    const ok = r.startsWith('OK');
    if (ok) record[i.kind === 'dir' ? 'dirs' : 'files'].push(i.target);
    results.push({ kind: i.kind, path: i.target, ok, detail: ok ? (i.kind === 'dir' ? `Restored ${r.slice(3)} files` : 'Restored') : r === 'EXISTS' ? 'Already exists here, left as it is' : r });
  }
  delete record.inFlight;
  await checkpoint();

  let k = 0;
  for (const i of keyItems) {
    const text = out[`reg${i.n}`];
    if (!text) {
      results.push({ kind: 'key', path: i.target, ok: false, detail: 'Missing from the backup file' });
      continue;
    }
    // An existing key is exported first, so undo can put it back exactly.
    const before = path.join(dir, `before-${++k}.reg`);
    const queried = await reg(['query', i.target]);
    const existed = queried.ok;
    if (!existed && !/unable to find|cannot find|not found/i.test(queried.stderr)) throw new Error(`Cannot determine whether ${i.target} exists; restore stopped before mutation`);
    if (existed && !(await reg(['export', i.target, before, '/y'])).ok) throw new Error(`Could not back up ${i.target}; restore stopped before mutation`);
    const regFile = path.join(dir, `restore-${k}.reg`);
    const approvedText = validateRegistryText(rewriteReg(text.replace(/^\uFEFF/, ''), backup.source), i.target);
    record.inFlight = { kind: 'key', path: i.target, before: existed ? path.basename(before) : null };
    await checkpoint();
    // reg.exe imports UTF-16 files only.
    await runPS(`[IO.File]::WriteAllText(${psq(regFile)}, [Console]::In.ReadToEnd(), [Text.Encoding]::Unicode)`, { input: approvedText });
    const r = await reg(['import', regFile]);
    if (!r.ok) throw new Error(`Registry import did not complete. Its recovery journal is retained: ${r.stderr}`);
    record.keys.push({ path: i.target, before: existed ? path.basename(before) : null });
    delete record.inFlight;
    await checkpoint();
    results.push({ kind: 'key', path: i.target, ok: r.ok, detail: r.ok ? (existed ? 'Merged into the existing key (its earlier contents were saved)' : 'Restored') : r.stderr });
  }

  for (const i of chosen.filter((x) => x.kind === 'value')) {
    const old = await runPSJson(
      `$ErrorActionPreference = 'Stop'
       $k = if (Test-Path -LiteralPath ${psq(`Registry::${i.target}`)} -ErrorAction Stop) { Get-Item -LiteralPath ${psq(`Registry::${i.target}`)} -ErrorAction Stop } else { $null }
       $n = ${psq(i.name)}
       if ($k -and $k.GetValueNames() -contains $n) {
         $d = $k.GetValue($n, $null, 'DoNotExpandEnvironmentNames')
         [pscustomobject]@{ kind = [string]$k.GetValueKind($n); data = if ($d -is [byte[]]) { ($d | ForEach-Object { $_.ToString('x2') }) -join '' } elseif ($d -is [string[]]) { $d -join '\\0' } else { [string]$d } } | ConvertTo-Json -Compress
       }`
    );
    const data = rewriteReg(String(i.data), backup.source);
    validateTarget(i.target, 'value');
    record.inFlight = { kind: 'value', path: i.target, name: i.name, old: old[0] || null };
    await checkpoint();
    const r = await reg(['add', i.target, ...(i.name ? ['/v', i.name] : ['/ve']), '/t', REG_TYPE[i.valueKind] || 'REG_SZ', '/d', data, '/f']);
    if (!r.ok) throw new Error(`Registry write did not complete. Its recovery journal is retained: ${r.stderr}`);
    record.values.push({ path: i.target, name: i.name, old: old[0] || null });
    delete record.inFlight;
    await checkpoint();
    results.push({ kind: 'value', path: i.target, name: i.name, ok: r.ok, detail: r.ok ? 'Restored' : r.stderr });
  }

  record.complete = true;
  record.pending = [];
  await checkpoint();
  return { id, name: record.name, results };
}

// Undoes a restore: restored folders and files go to the Recycle Bin, restored keys are deleted
// (and earlier contents re-imported), and values are put back or removed.
export async function undo(id) {
  if (!/^\d+$/.test(String(id))) throw new Error('Invalid restore id');
  const dir = path.join(root, String(id));
  const record = JSON.parse(await sys.readText(path.join(dir, 'restore.json')));
  if (record.complete === false) throw new Error('This restore was interrupted. Its journal and backups are retained; review the pending items before recovery. Automatic undo is refused for uncertain mutations.');
  const results = [];
  for (const p of [...record.dirs, ...record.files]) {
    if (isProtected(p)) {
      results.push({ kind: 'dir', path: p, ok: false, detail: 'Protected location, left in place' });
      continue;
    }
    try {
      // A copy that replaced your settings is deleted outright (it is still in the package), so
      // the Recycle Bin holds only your earlier settings under that path.
      const replacing = (record.replaced || []).some((r) => r.toLowerCase() === p.toLowerCase());
      if (await sys.exists(p)) await sys.trash(p);
      results.push({ kind: 'dir', path: p, ok: true, detail: replacing ? 'Restored copy moved to Recycle Bin; earlier settings are restored below' : 'Moved to Recycle Bin' });
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
  // Settings a sync replaced come back out of the Recycle Bin.
  if (record.replaced?.length) {
    const back = await restoreManyFromRecycleBin(record.replaced).catch(() => ({}));
    for (const p of record.replaced) results.push({ kind: 'dir', path: p, ok: back[p] === 'OK', detail: back[p] === 'OK' ? 'Earlier settings put back' : 'Earlier settings are not in the Recycle Bin any more' });
  }
  return results;
}

// Items a program backup offers by default: what the leftover scan is sure about, minus things
// that can't be carried to another PC (services, tasks, firewall rules).
export const backupCandidates = (scanItems) => scanItems.filter((i) => ['dir', 'file', 'key', 'value'].includes(i.kind));

// Packages in a folder (whole-PC migration and settings sync): [{ file, name, mtime }].
export async function folderPackages(folder) {
  const out = [];
  for (const e of (await sys.readDir(folder).catch(() => [])).filter((x) => x.file && /\.swpkg$/i.test(x.name))) {
    const s = await sys.stat(path.join(folder, e.name)).catch(() => null);
    out.push({ file: path.join(folder, e.name), name: e.name.replace(/\.swpkg$/i, ''), mtime: s?.modified || 0 });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export const defaultFileName = (program) => `${String(program.name).replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'program'}${program.version ? ` ${program.version}` : ''}.swpkg`;
