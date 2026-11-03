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
    # Match the native undo snapshot's per-item 512 MiB / 10,000 nodes / depth 64.
    # Include the selected root and implicit directories, not just ZIP entries.
    $nodes = @{}; $nodes[$base.ToLowerInvariant()] = ($i.kind -eq 'dir')
    $itemBytes = [long]0
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
      $depth = if ($i.kind -eq 'file') { 0 } else { $segments.Count }
      $itemBytes += $entry.Length
      if ($depth -gt 64 -or $itemBytes -gt 536870912) { throw 'Selected item exceeds resumable undo depth or byte limits' }
      if ($dest -ne $base -and -not $dest.StartsWith($base + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Archive path escapes approved folder' }
      $key = $dest.ToLowerInvariant()
      if ($destinations.ContainsKey($key)) { throw 'Archive contains duplicate destinations' }
      $destinations[$key] = $true
      $node = $dest; $nodeDirectory = $entry.FullName.EndsWith('/')
      while ($true) {
        $nodeKey = $node.ToLowerInvariant()
        if ($nodes.ContainsKey($nodeKey)) {
          if ($nodes[$nodeKey] -ne $nodeDirectory) { throw 'Archive file conflicts with an implicit directory' }
        } else {
          if ($nodes.Count -ge 10000) { throw 'Selected item exceeds resumable undo node limit' }
          $nodes[$nodeKey] = $nodeDirectory
        }
        if ($node -eq $base) { break }
        $node = Split-Path -Parent $node; $nodeDirectory = $true
      }
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
  const chosen = backup.items.filter((i) => numbers.includes(i.n) && !i.blocked && !i.skip);
  independentTargets(chosen.map((i) => ({ kind: i.kind, path: i.target, ...(i.kind === 'value' ? { name: i.name } : {}) })));
  const chosenPaths = chosen.filter((i) => ['file', 'dir'].includes(i.kind)).map((i) => i.target.toLowerCase());
  if (replace && chosenPaths.some((target, index) => chosenPaths.some((other, j) => index !== j && (target === other || target.startsWith(other + '\\'))))) throw new Error('Overlapping replacement targets require separate reviewed restores');
  // Validate all registry contents before any file replacement or registry write.
  const registryOut = (await runPSJson(EXTRACT, { input: JSON.stringify({ file, preflight: true, items: chosen.filter((i) => ['file', 'dir'].includes(i.kind)).map(({ n, kind, target }) => ({ n, kind, target })), keys: chosen.filter((i) => i.kind === 'key').map(({ n }) => ({ n })) }) }))[0] || {};
  for (const i of chosen.filter((i) => i.kind === 'key')) validateRegistryText(rewriteReg(registryOut[`reg${i.n}`] || '', backup.source), i.target);
  const reservation = await sys.reserveTransferRestore();
  if (!plainRecord(reservation) || typeof reservation.id !== 'string' || !/^[1-9][0-9]{0,31}$/.test(reservation.id) || typeof reservation.token !== 'string' || !reservation.token.length) throw new Error('Native restore reservation was not confirmed');
  const id = reservation.id;
  const dir = path.join(root, id);
  try {
  const record = { id, name: backup.program.name, file, created: new Date().toISOString(), dirs: [], files: [], keys: [], values: [], replaced: [], replacementReceipts: [], undoPlan: { version: 1, items: [] } };
  record.complete = false;
  record.pending = chosen.map((i) => ({ kind: i.kind, target: i.target, n: i.n }));
  const checkpoint = () => saveRestoreRecord(dir, record);
  await checkpoint();
  const results = backup.items.filter((i) => numbers.includes(i.n) && i.blocked).map((i) => ({ kind: i.kind, path: i.target, name: i.name, ok: false, detail: i.blocked }));

  const fileItems = chosen.filter((i) => i.kind === 'dir' || i.kind === 'file');
  // Bind every displaced original to its exact native Recycle Bin identity.
  for (const i of fileItems.filter((x) => replace && isSettings({ kind: x.kind, path: x.target }))) {
    if (!(await sys.exists(i.target))) continue;
    try {
      record.inFlight = { kind: 'replace', target: i.target };
      await checkpoint();
      const receipt = await sys.captureTransferReplacement(i.target, i.kind === 'dir');
      if (!validReplacementReceipt(receipt, i.target, i.kind)) throw new Error('Native replacement capture returned invalid recovery evidence');
      record.replacementReceipts.push(receipt);
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
    if (!ok && record.replaced.some((target) => target.toLowerCase() === i.target.toLowerCase())) throw new Error('Replacement extraction did not complete; its exact original and recovery journal are retained for review');
    if (ok) {
      const expected = await observe({ kind: i.kind, path: i.target });
      if (!expected.exists) throw new Error('Restored item disappeared before its undo state could be recorded');
      record[i.kind === 'dir' ? 'dirs' : 'files'].push(i.target);
      const receipt = record.replacementReceipts.find((entry) => entry.target.toLowerCase() === i.target.toLowerCase());
      record.undoPlan.items.push({ ordinal: record.undoPlan.items.length, kind: i.kind, path: i.target, expected, goal: receipt ? { version: 1, exists: true, digest: receipt.digest, identity: receipt.identity } : absentState(), evidence: null, phase: 'stage', status: 'pending' });
    }
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
    const original = await observe({ kind: 'key', path: i.target });
    const queried = await reg(['query', i.target]);
    const existed = queried.ok;
    if (!existed && !/unable to find|cannot find|not found/i.test(queried.stderr)) throw new Error(`Cannot determine whether ${i.target} exists; restore stopped before mutation`);
    if (existed && !(await reg(['export', i.target, before, '/y'])).ok) throw new Error(`Could not back up ${i.target}; restore stopped before mutation`);
    const evidence = existed ? await evidenceHash(await readUndoExport(before, i.target)) : null;
    if (existed !== original.exists || !sameState(await observe({ kind: 'key', path: i.target }), original)) throw new Error('Registry key changed while its original undo evidence was captured');
    const regFile = path.join(dir, `restore-${k}.reg`);
    const approvedText = validateRegistryText(rewriteReg(text.replace(/^\uFEFF/, ''), backup.source), i.target);
    record.inFlight = { kind: 'key', path: i.target, before: existed ? path.basename(before) : null };
    await checkpoint();
    // reg.exe imports UTF-16 files only.
    await runPS(`[IO.File]::WriteAllText(${psq(regFile)}, [Console]::In.ReadToEnd(), [Text.Encoding]::Unicode)`, { input: approvedText });
    const r = await reg(['import', regFile]);
    if (!r.ok) throw new Error(`Registry import did not complete. Its recovery journal is retained: ${r.stderr}`);
    const expected = await observe({ kind: 'key', path: i.target });
    if (!expected.exists) throw new Error('Restored registry key could not be verified');
    record.keys.push({ path: i.target, before: existed ? path.basename(before) : null });
    record.undoPlan.items.push({ ordinal: record.undoPlan.items.length, kind: 'key', path: i.target, expected, goal: original, evidence, phase: 'clear', status: 'pending' });
    delete record.inFlight;
    await checkpoint();
    results.push({ kind: 'key', path: i.target, ok: r.ok, detail: r.ok ? (existed ? 'Merged into the existing key (its earlier contents were saved)' : 'Restored') : r.stderr });
  }

  for (const i of chosen.filter((x) => x.kind === 'value')) {
    const original = await observe({ kind: 'value', path: i.target, name: i.name });
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
    if (old.length > 1 || original.exists !== !!old[0] || old[0] && !validUndoValue(old[0])) throw new Error('Original registry value cannot be represented by this undo format');
    if (!sameState(await observe({ kind: 'value', path: i.target, name: i.name }), original)) throw new Error('Registry value changed while its original undo evidence was captured');
    validateTarget(i.target, 'value');
    record.inFlight = { kind: 'value', path: i.target, name: i.name, old: old[0] || null };
    await checkpoint();
    const r = await reg(['add', i.target, ...(i.name ? ['/v', i.name] : ['/ve']), '/t', REG_TYPE[i.valueKind] || 'REG_SZ', '/d', data, '/f']);
    if (!r.ok) throw new Error(`Registry write did not complete. Its recovery journal is retained: ${r.stderr}`);
    const expected = await observe({ kind: 'value', path: i.target, name: i.name });
    if (!expected.exists) throw new Error('Restored registry value could not be verified');
    record.values.push({ path: i.target, name: i.name, old: old[0] || null });
    record.undoPlan.items.push({ ordinal: record.undoPlan.items.length, kind: 'value', path: i.target, name: i.name, expected, goal: original, evidence: await evidenceHash(valueEvidence(old[0] || null)), phase: 'value', status: 'pending' });
    delete record.inFlight;
    await checkpoint();
    results.push({ kind: 'value', path: i.target, name: i.name, ok: r.ok, detail: r.ok ? 'Restored' : r.stderr });
  }

  record.complete = true;
  record.pending = [];
  await checkpoint();
  return { id, name: record.name, results };
  } finally { await sys.releaseTransferUndo(reservation.token); }
}

const plainRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const undoError = () => new Error('Invalid or incomplete restore evidence. Undo cannot continue; its files are retained for manual review.');
const boundedText = (value, max) => typeof value === 'string' && value.length <= max && !/[\x00-\x1f]/.test(value);
const absentState = () => ({ version: 1, exists: false, digest: null, identity: null });
const valueEvidence = (old) => JSON.stringify(old === null ? null : { kind: old.kind, data: old.data });
async function evidenceHash(text) {
  const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
const sameState = (a, b) => a.version === b.version && a.exists === b.exists && a.digest === b.digest && (a.identity === null && b.identity === null || a.identity && b.identity && ['volume', 'high', 'low'].every((key) => a.identity[key] === b.identity[key]));
function validState(value, kind) {
  if (!plainRecord(value) || Object.keys(value).some((key) => !['version', 'exists', 'digest', 'identity'].includes(key)) || value.version !== 1 || typeof value.exists !== 'boolean') return false;
  if (!value.exists) return value.digest === null && value.identity === null;
  if (typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.digest)) return false;
  if (!['file', 'dir'].includes(kind)) return value.identity === null;
  return plainRecord(value.identity) && Object.keys(value.identity).length === 3 && ['volume', 'high', 'low'].every((key) => Number.isInteger(value.identity[key]) && value.identity[key] >= 0 && value.identity[key] <= 0xffffffff);
}
async function observe(target) {
  const state = await sys.observeTransferTarget(target);
  if (!validState(state, target.kind)) throw new Error('Native undo observation returned invalid evidence');
  return { version: 1, exists: state.exists, digest: state.digest, identity: state.identity };
}
async function saveRestoreRecord(dir, record) {
  const text = JSON.stringify(record, null, 2);
  if (text.length > 1048576) throw new Error('Restore journal exceeds the recovery size limit');
  await sys.writeTextAtomic(path.join(dir, 'restore.json'), text);
}
function independentTargets(items) {
  const fs = items.filter((item) => ['file', 'dir'].includes(item.kind));
  for (let i = 0; i < fs.length; i++) for (let j = i + 1; j < fs.length; j++) {
    const a = fs[i].path.toLowerCase(), b = fs[j].path.toLowerCase();
    if (a === b || a.startsWith(b + '\\') || b.startsWith(a + '\\')) throw new Error('Overlapping file undo targets require separate restores');
  }
  const registry = items.filter((item) => ['key', 'value'].includes(item.kind));
  for (let i = 0; i < registry.length; i++) for (let j = i + 1; j < registry.length; j++) {
    const a = registryIdentity(registry[i].path), b = registryIdentity(registry[j].path);
    if (registry[i].kind === 'value' && registry[j].kind === 'value') {
      if (a === b && registry[i].name.toLowerCase() === registry[j].name.toLowerCase()) throw new Error('Duplicate undo value target');
    } else if (a === b || a.startsWith(b + '\\') || b.startsWith(a + '\\')) throw new Error('Overlapping registry undo targets require separate restores');
  }
}
function validReplacementReceipt(receipt, target, kind) {
  return plainRecord(receipt) && receipt.version === 1 && boundedText(receipt.target, 4096) && receipt.target.toLowerCase() === target.toLowerCase()
    && Object.keys(receipt).every((key) => ['version', 'target', 'sid', 'machine', 'infoName', 'infoSha256', 'identity', 'directory', 'digest'].includes(key))
    && boundedText(receipt.sid, 184) && /^S-1-(?:\d+-)*\d+$/.test(receipt.sid) && boundedText(receipt.machine, 256) && receipt.machine.length > 0
    && typeof receipt.infoName === 'string' && receipt.infoName.length <= 255 && /^\$I[^\\/:*?"<>|\x00-\x1f]+$/.test(receipt.infoName) && !/[. ]$/.test(receipt.infoName)
    && ['infoSha256', 'digest'].every((key) => typeof receipt[key] === 'string' && /^[a-f0-9]{64}$/i.test(receipt[key]))
    && plainRecord(receipt.identity) && Object.keys(receipt.identity).every((key) => ['volume', 'high', 'low'].includes(key)) && ['volume', 'high', 'low'].every((key) => Number.isInteger(receipt.identity[key]) && receipt.identity[key] >= 0 && receipt.identity[key] <= 0xffffffff)
    && typeof receipt.directory === 'boolean' && receipt.directory === (kind === 'dir');
}
const registryIdentity = (value) => value.replace(/^HKLM\\/i, 'HKEY_LOCAL_MACHINE\\').replace(/^HKCU\\/i, 'HKEY_CURRENT_USER\\').replace(/^HKCR\\/i, 'HKEY_CLASSES_ROOT\\').replace(/^HKU\\/i, 'HKEY_USERS\\').replace(/^HKCC\\/i, 'HKEY_CURRENT_CONFIG\\').toLowerCase();
function validUndoValue(old) {
  if (!plainRecord(old) || typeof old.kind !== 'string' || !Object.hasOwn(REG_TYPE, old.kind) || typeof old.data !== 'string' || old.data.length > 1048576 || old.data.includes('\0')) return false;
  if (old.kind === 'Binary') return /^(?:[0-9a-f]{2})*$/i.test(old.data);
  if (old.kind === 'DWord' || old.kind === 'QWord') {
    if (!/^-?[0-9]{1,20}$/.test(old.data)) return false;
    const number = BigInt(old.data), bits = old.kind === 'DWord' ? 32n : 64n;
    return number >= -(1n << (bits - 1n)) && number < (1n << bits);
  }
  return true;
}
function undoTarget(target, kind) {
  validateTarget(target, kind);
  if (['key', 'value'].includes(kind) && (!/^(?:HKLM|HKCU|HKCR|HKU|HKCC|HKEY_LOCAL_MACHINE|HKEY_CURRENT_USER|HKEY_CLASSES_ROOT|HKEY_USERS|HKEY_CURRENT_CONFIG)\\[^\\]+(?:\\[^\\]+)*$/i.test(target) || target.split('\\').some((part) => part === '.' || part === '..'))) throw undoError();
}

// reg.exe exports UTF-16 as well as UTF-8. Read only a bounded file and detect its BOM.
const READ_UNDO_EXPORT = `
$ErrorActionPreference = 'Stop'
$inputPath = [Console]::In.ReadToEnd() | ConvertFrom-Json
$stream = [IO.File]::Open([string]$inputPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
try {
  if ($stream.Length -gt 8388608) { throw 'Registry export exceeds safety limits' }
  $reader = New-Object IO.StreamReader($stream, (New-Object Text.UTF8Encoding($false, $true)), $true)
  try { [pscustomobject]@{ text = $reader.ReadToEnd() } | ConvertTo-Json -Compress } finally { $reader.Dispose() }
} finally { $stream.Dispose() }
`;
async function readUndoExport(file, target) {
  const rows = await runPSJson(READ_UNDO_EXPORT, { input: JSON.stringify(file) });
  if (rows.length !== 1 || typeof rows[0]?.text !== 'string') throw undoError();
  return validateRegistryText(rows[0].text, target);
}
async function preflightUndo(record, id, dir, lease) {
  if (!plainRecord(record) || record.id !== id || record.complete !== true || Object.hasOwn(record, 'inFlight') || Object.hasOwn(record, 'recovery') || record.pending !== undefined && (!Array.isArray(record.pending) || record.pending.length)) throw undoError();
  for (const name of ['dirs', 'files', 'keys', 'values']) if (!Array.isArray(record[name])) throw undoError();
  if (record.replaced !== undefined && !Array.isArray(record.replaced)) throw undoError();
  for (const name of ['name', 'file', 'created']) if (record[name] !== undefined && !boundedText(record[name], 4096)) throw undoError();
  const replaced = record.replaced || [];
  const receipts = record.replacementReceipts;
  if (receipts !== undefined && !Array.isArray(receipts) || replaced.length && (!Array.isArray(receipts) || receipts.length !== replaced.length) || !replaced.length && receipts?.length) throw undoError();
  if ([record.dirs, record.files, record.keys, record.values, replaced].reduce((count, rows) => count + rows.length, 0) > 10000) throw undoError();
  const paths = new Set();
  for (const kind of ['dir', 'file']) for (const target of record[kind === 'dir' ? 'dirs' : 'files']) {
    undoTarget(target, kind);
    if (paths.has(target.toLowerCase())) throw undoError();
    paths.add(target.toLowerCase());
  }
  const replacements = new Set();
  const receiptMap = new Map(), receiptIds = new Set();
  for (const target of replaced) {
    undoTarget(target, 'file');
    if (!paths.has(target.toLowerCase()) || replacements.has(target.toLowerCase()) || !isSettings({ kind: 'file', path: target })) throw undoError();
    replacements.add(target.toLowerCase());
    const candidates = receipts.filter((receipt) => plainRecord(receipt) && typeof receipt.target === 'string' && receipt.target.toLowerCase() === target.toLowerCase());
    const kind = record.dirs.some((path) => path.toLowerCase() === target.toLowerCase()) ? 'dir' : 'file';
    if (candidates.length !== 1 || !validReplacementReceipt(candidates[0], target, kind)) throw undoError();
    const receipt = candidates[0], identity = `${receipt.identity.volume}:${receipt.infoName.toLowerCase()}`;
    if (receiptIds.has(identity)) throw undoError();
    receiptIds.add(identity); receiptMap.set(target.toLowerCase(), receipt);
  }
  // An ancestor removal could destroy another receipt's destination or payload context.
  const filePaths = [...paths];
  if (replaced.length && filePaths.some((target, index) => filePaths.some((other, j) => index !== j && target.startsWith(other + '\\')))) throw undoError();
  const keys = new Set(), exports = new Map(), names = new Set();
  for (const entry of record.keys) {
    if (!plainRecord(entry) || !Object.hasOwn(entry, 'before')) throw undoError();
    undoTarget(entry.path, 'key');
    const identity = registryIdentity(entry.path);
    if (keys.has(identity)) throw undoError();
    keys.add(identity);
    if (entry.before !== null) {
      if (typeof entry.before !== 'string' || !/^before-[1-9][0-9]*\.reg$/.test(entry.before) || names.has(entry.before.toLowerCase())) throw undoError();
      names.add(entry.before.toLowerCase());
      const file = path.join(dir, entry.before);
      if (path.dirname(file).toLowerCase() !== dir.toLowerCase()) throw undoError();
      exports.set(entry.before, { file, target: entry.path });
    }
  }
  const values = new Set();
  for (const entry of record.values) {
    if (!plainRecord(entry) || !Object.hasOwn(entry, 'old') || typeof entry.name !== 'string' || entry.name.length > 16383 || entry.name.includes('\0')) throw undoError();
    undoTarget(entry.path, 'value');
    const identity = JSON.stringify([registryIdentity(entry.path), entry.name.toLowerCase()]);
    if (values.has(identity)) throw undoError();
    values.add(identity);
    if (entry.old !== null && !validUndoValue(entry.old)) throw undoError();
  }
  const items = validateUndoPlan(record, receiptMap);
  for (const item of items.filter((item) => item.status !== 'done')) {
    if (item.phase === 'original' && await sys.savedTransferUndoStage(lease, id, item.ordinal, { kind: item.kind, path: item.path }, item.expected) !== true) throw new Error('Retained staging evidence does not prove this original-restore phase');
    if (item.kind === 'key') {
      const key = record.keys.find((key) => key.path.toLowerCase() === item.path.toLowerCase());
      if (key.before) {
        const text = await readUndoExport(exports.get(key.before).file, key.path);
        if (await evidenceHash(text) !== item.evidence) throw new Error('Saved registry export differs from the original undo evidence');
        exports.set(key.before, text);
      }
    } else if (item.kind === 'value') {
      const value = record.values.find((value) => value.path.toLowerCase() === item.path.toLowerCase() && value.name === item.name);
      if (await evidenceHash(valueEvidence(value.old)) !== item.evidence) throw new Error('Saved registry value differs from the original undo evidence');
    }
    const receipt = receiptMap.get(item.path.toLowerCase());
    if (receipt && !(item.phase === 'original' && await sys.transferOriginalAtTarget(item.path, receipt))) await sys.validateTransferReplacement(item.path, receipt);
  }
  return { exports, receiptMap, items };
}

function validateUndoPlan(record, receiptMap) {
  const plan = record.undoPlan;
  if (!plainRecord(plan) || plan.version !== 1 || Object.keys(plan).some((key) => !['version', 'items'].includes(key)) || !Array.isArray(plan.items)) throw new Error('This restore lacks trustworthy per-item undo state; its evidence requires manual review');
  const targets = [...record.dirs.map((path) => ({ kind: 'dir', path })), ...record.files.map((path) => ({ kind: 'file', path })), ...record.keys.map(({ path }) => ({ kind: 'key', path })), ...record.values.map(({ path, name }) => ({ kind: 'value', path, name }))];
  independentTargets(targets);
  if (plan.items.length !== targets.length) throw undoError();
  const used = new Set(), fileIds = new Set(); let unfinished = false;
  for (const [ordinal, item] of plan.items.entries()) {
    if (!plainRecord(item) || item.ordinal !== ordinal || Object.keys(item).some((key) => !['ordinal', 'kind', 'path', 'name', 'expected', 'goal', 'evidence', 'phase', 'status'].includes(key)) || typeof item.path !== 'string' || !['pending', 'intent', 'done'].includes(item.status)) throw undoError();
    const index = targets.findIndex((target) => target.kind === item.kind && target.path.toLowerCase() === item.path.toLowerCase() && (target.kind !== 'value' ? item.name === undefined : target.name === item.name));
    if (index < 0 || used.has(index) || !validState(item.expected, item.kind) || !item.expected.exists || !validState(item.goal, item.kind)) throw undoError();
    used.add(index);
    let phases;
    if (['file', 'dir'].includes(item.kind)) {
      const key = ['volume', 'high', 'low'].map((name) => item.expected.identity[name]).join(':');
      if (fileIds.has(key)) throw undoError(); fileIds.add(key);
      const receipt = receiptMap.get(item.path.toLowerCase());
      phases = receipt ? ['stage', 'original'] : ['stage'];
      if (item.evidence !== null || (receipt ? !sameState(item.goal, { version: 1, exists: true, digest: receipt.digest, identity: receipt.identity }) : item.goal.exists)) throw undoError();
    } else if (item.kind === 'key') {
      const key = record.keys.find((key) => key.path.toLowerCase() === item.path.toLowerCase());
      if (!!key.before !== item.goal.exists || (key.before ? typeof item.evidence !== 'string' || !/^[a-f0-9]{64}$/.test(item.evidence) : item.evidence !== null)) throw undoError(); phases = key.before ? ['clear', 'import'] : ['clear'];
    } else {
      const value = record.values.find((value) => value.path.toLowerCase() === item.path.toLowerCase() && value.name === item.name);
      if ((value.old !== null) !== item.goal.exists || typeof item.evidence !== 'string' || !/^[a-f0-9]{64}$/.test(item.evidence)) throw undoError(); phases = ['value'];
    }
    if (!phases.includes(item.phase) || item.status === 'done' && item.phase !== phases.at(-1) || unfinished && item.status !== 'pending' || unfinished && item.phase !== phases[0]) throw undoError();
    if (item.status !== 'done') unfinished = true;
  }
  return plan.items;
}

// Local journals are not authenticated native authority. Validate the whole journal and
// every saved export before changing anything; retain all evidence on any failure.
const undoCalls = new Set();
export async function undo(id) {
  if (!(typeof id === 'string' && /^[1-9][0-9]*$/.test(id) || Number.isSafeInteger(id) && id > 0)) throw new Error('Invalid restore id');
  id = String(id);
  const dir = path.join(root, id), operation = dir.toLowerCase();
  if (undoCalls.has(operation)) throw new Error('This undo journal is already in use');
  undoCalls.add(operation);
  let lease;
  try {
    lease = await sys.acquireTransferUndo(id);
    if (typeof lease !== 'string' || !lease.length) throw new Error('Native undo lock was not confirmed');
    const text = await sys.readText(path.join(dir, 'restore.json'));
    if (typeof text !== 'string' || text.length > 1048576) throw undoError();
    const record = JSON.parse(text);
    const { exports, receiptMap, items } = await preflightUndo(record, id, dir, lease);
    const results = [];
    let halted = false;
    const save = () => saveRestoreRecord(dir, record);
    for (const [step, item] of items.entries()) {
      const row = { kind: item.kind, path: item.path, ...(item.kind === 'value' ? { name: item.name } : {}) };
      if (item.status === 'done') { results.push({ ...row, ok: true, undoComplete: true, detail: 'Undo already confirmed; left untouched' }); continue; }
      if (halted) { results.push({ ...row, ok: false, undoComplete: false, detail: 'Left untouched because an earlier undo item needs review' }); continue; }
      try {
        const target = { kind: item.kind, path: item.path, ...(item.kind === 'value' ? { name: item.name } : {}) };
        const receipt = receiptMap.get(item.path.toLowerCase());
        while (item.status !== 'done') {
          let completed = false;
          if (item.phase === 'stage') {
            completed = await sys.stageTransferUndo(lease, id, step, target, item.expected, false);
            if (typeof completed !== 'boolean') throw new Error('Undo staging observation was not confirmed');
            if (completed && item.status !== 'intent') throw new Error('Undo conflict: an unrecorded staging outcome needs review');
            if (!completed) {
              item.status = 'intent'; await save();
              if (await sys.stageTransferUndo(lease, id, step, target, item.expected, true) !== true) throw new Error('Undo staging was not confirmed');
            }
            item.phase = receipt ? 'original' : 'stage'; item.status = receipt ? 'pending' : 'done'; await save();
          } else if (item.phase === 'original') {
            if (await sys.savedTransferUndoStage(lease, id, step, target, item.expected) !== true) throw new Error('Retained imported copy does not prove the prior undo stage');
            completed = await sys.transferOriginalAtTarget(item.path, receipt);
            if (typeof completed !== 'boolean') throw new Error('Original identity observation was not confirmed');
            if (completed && item.status !== 'intent') throw new Error('Undo conflict: original appeared before its recorded restore intent');
            if (!completed) {
              if ((await observe(target)).exists) throw new Error('Undo conflict: destination changed before restoring the original');
              await sys.validateTransferReplacement(item.path, receipt);
              item.status = 'intent'; await save();
              const result = await sys.restoreTransferReplacement(item.path, receipt);
              if (result?.restored !== true || await sys.transferOriginalAtTarget(item.path, receipt) !== true) throw new Error('Exact original restoration was not verified');
            }
            item.status = 'done'; await save();
          } else {
            if (item.kind === 'key' && item.goal.exists) {
              const key = record.keys.find((key) => key.path.toLowerCase() === item.path.toLowerCase());
              if (await readUndoExport(path.join(dir, key.before), item.path) !== exports.get(key.before)) throw new Error('Saved registry export changed; undo refused');
            }
            const before = item.phase === 'import' ? absentState() : item.expected;
            const goal = item.phase === 'clear' ? absentState() : item.goal;
            const current = await observe(target);
            completed = sameState(current, goal);
            if (completed && item.status !== 'intent' && !sameState(before, goal)) throw new Error('Undo conflict: target changed before its recorded intent');
            if (!completed) {
              if (!sameState(current, before)) throw new Error('Undo conflict: registry contents differ from the recorded state');
              item.status = 'intent'; await save();
              // This guard narrows external-writer races; registry commands are not a CAS.
              if (!sameState(await observe(target), before)) throw new Error('Undo conflict: registry changed before mutation');
              let result;
              if (item.phase === 'clear') result = await reg(['delete', item.path, '/f']);
              else if (item.phase === 'import') {
                const key = record.keys.find((key) => key.path.toLowerCase() === item.path.toLowerCase());
                result = await reg(['import', path.join(dir, key.before)]);
              } else {
                const value = record.values.find((value) => value.path.toLowerCase() === item.path.toLowerCase() && value.name === item.name);
                result = value.old
                  ? await reg(['add', item.path, ...(item.name ? ['/v', item.name] : ['/ve']), '/t', REG_TYPE[value.old.kind], '/d', value.old.data, '/f'])
                  : await reg(['delete', item.path, ...(item.name ? ['/v', item.name] : ['/ve']), '/f']);
              }
              if (!result.ok) throw new Error(result.stderr || 'Registry undo did not complete');
              if (!sameState(await observe(target), goal)) throw new Error('Registry undo outcome differs from the recorded goal; manual review is required');
            }
            if (item.phase === 'clear' && item.goal.exists) { item.phase = 'import'; item.status = 'pending'; }
            else item.status = 'done';
            await save();
          }
        }
        results.push({ ...row, ok: true, undoComplete: true, detail: receipt ? 'Exact original settings put back' : 'Undo confirmed; recovery evidence retained' });
      } catch (error) {
        halted = true;
        results.push({ ...row, ok: false, undoComplete: false, detail: `${error?.message || error}. Undo stopped; retained evidence needs review before retrying.` });
      }
    }
    return results;
  } finally {
    undoCalls.delete(operation);
    if (lease) await sys.releaseTransferUndo(lease);
  }
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
