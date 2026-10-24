// Backs up and removes leftover items, and restores backups.
// Registry keys are exported to .reg files, values are recorded with their type and data,
// and files go to the Recycle Bin, so every removal can be undone.
import { sys } from './sys.js';
import * as path from './winpath.js';
import { reg, runPS, runPSJson, psq, execFile } from './shell.js';
import { isProtected, isProtectedKey } from './paths.js';
import { regAddArgs } from './snapshots.js';
import { isJunkPath } from './junk.js';
import { readState, guardReason } from './safety.js';

let backupRoot = '';
const setRoot = async (dir) => {
  backupRoot = dir;
  await sys.makeDir(backupRoot);
};

const slug = (s) => (s || 'items').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 40);

async function readValues(values) {
  if (!values.length) return [];
  const input = JSON.stringify(values.map((v) => ({ path: v.path, name: v.name })));
  return runPSJson(
    `$in = [Console]::In.ReadToEnd() | ConvertFrom-Json
     $out = foreach ($v in $in) {
       $k = Get-Item -LiteralPath "Registry::$($v.path)" -ErrorAction SilentlyContinue
       if (-not $k) { continue }
       $data = $k.GetValue($v.name, $null, 'DoNotExpandEnvironmentNames')
       if ($null -eq $data) { continue }
       $kind = [string]$k.GetValueKind($v.name)
       if ($data -is [byte[]]) { $data = ($data | ForEach-Object { $_.ToString('x2') }) -join '' }
       elseif ($data -is [string[]]) { $data = $data -join '\\0' }
       [pscustomobject]@{ path=$v.path; name=$v.name; valueKind=$kind; data=[string]$data }
     }
     @($out) | ConvertTo-Json -Compress`,
    { input }
  );
}

const REG_TYPE = { String: 'REG_SZ', ExpandString: 'REG_EXPAND_SZ', DWord: 'REG_DWORD', QWord: 'REG_QWORD', Binary: 'REG_BINARY', MultiString: 'REG_MULTI_SZ' };

// `owners`: uninstall keys of the programs being removed (see safety.js). `state` replaces the
// live system state in tests.
async function removeItems({ title, items, owners = [], state, trashItem = (p) => sys.trash(p) }) {
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}_${slug(title)}`;
  const dir = path.join(backupRoot, id);
  await sys.makeDir(dir);
  const manifest = { id, title, created: new Date().toISOString(), entries: [] };
  const results = [];
  const log = (item, ok, detail) => results.push({ ...item, ok, detail });

  // Last check before deleting: is anything still used by another installed program?
  // If the check itself cannot run, files, folders and keys are left alone.
  const guarded = items.some((i) => ['dir', 'file', 'key'].includes(i.kind));
  const live = guarded ? state || (await readState().catch(() => null)) : null;
  const blocked = (item) => (!guarded ? null : live ? guardReason(item, live, owners) : 'Could not check whether other programs use this, not deleted');

  // Services first, so their files are no longer locked. The service's registry definition is
  // exported first; importing it back recreates the service after a reboot.
  let s = 0;
  for (const item of items.filter((i) => i.kind === 'service')) {
    // Never delete Windows' own services: protected ones, or ones whose program lives in the Windows folder.
    const guard = await runPS(`
      $s = Get-CimInstance Win32_Service -Filter ${psq(`Name='${String(item.path).replace(/'/g, "''")}'`)} -ErrorAction SilentlyContinue
      if (-not $s) { 'GONE'; return }
      $prot = (& sc.exe qprotection ${psq(item.path)} 2>$null | Out-String)
      if ($prot -notmatch 'PROTECTION LEVEL:\\s*NONE') { 'PROTECTED'; return }
      if ([string]$s.PathName -match ('^\\W*' + [regex]::Escape($env:SystemRoot) + '\\\\')) { 'WINDOWS'; return }
      'OK'`).catch(() => 'ERR');
    if (/^GONE/.test(guard.trim())) {
      log(item, true, 'Already gone');
      continue;
    }
    if (!/^OK/.test(guard.trim())) {
      log(item, false, /^ERR/.test(guard.trim()) ? 'Could not check the service, not deleted' : 'Windows service, skipped');
      continue;
    }
    const file = path.join(dir, `service-${++s}.reg`);
    const ex = await reg(['export', `HKLM\\SYSTEM\\CurrentControlSet\\Services\\${item.path}`, file, '/y']);
    if (!ex.ok) {
      log(item, /unable to find/i.test(ex.stderr), /unable to find/i.test(ex.stderr) ? 'Already gone' : `Backup failed, not deleted: ${ex.stderr}`);
      continue;
    }
    await runPS(`Stop-Service -Name ${psq(item.path)} -Force -ErrorAction SilentlyContinue`).catch(() => {});
    const r = await execFile('sc.exe', ['delete', item.path]);
    if (r.ok) manifest.entries.push({ kind: 'service', path: item.path, file: path.basename(file) });
    log(item, r.ok, r.ok ? 'Service deleted' : r.out);
  }

  // Scheduled tasks: exported to XML, then unregistered.
  let t = 0;
  for (const item of items.filter((i) => i.kind === 'task')) {
    if (/^\\Microsoft\\/i.test(item.path)) {
      log(item, false, 'Windows task, skipped');
      continue;
    }
    const file = path.join(dir, `task-${++t}.xml`);
    const out = await runPS(`
      $t = Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { ($_.TaskPath + $_.TaskName) -eq ${psq(item.path)} } | Select-Object -First 1
      if (-not $t) { 'GONE'; return }
      Export-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath | Set-Content -LiteralPath ${psq(file)} -Encoding Unicode
      Unregister-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath -Confirm:$false -ErrorAction Stop
      if (Get-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath -ErrorAction SilentlyContinue) { 'ERR Task is still registered' } else { 'OK' }`).catch((e) => `ERR ${e.message}`);
    if (/^GONE/.test(out.trim())) log(item, true, 'Already gone');
    else if (/^OK/.test(out.trim())) {
      manifest.entries.push({ kind: 'task', path: item.path, file: path.basename(file) });
      log(item, true, 'Task removed');
    } else log(item, false, out.trim().replace(/^ERR /, ''));
  }

  // Firewall rules: settings saved to JSON, then removed.
  let f = 0;
  for (const item of items.filter((i) => i.kind === 'firewall')) {
    const file = path.join(dir, `firewall-${++f}.json`);
    const out = await runPS(`
      $r = Get-NetFirewallRule -Name ${psq(item.path)} -ErrorAction SilentlyContinue
      if (-not $r) { 'GONE'; return }
      $a = $r | Get-NetFirewallApplicationFilter; $p = $r | Get-NetFirewallPortFilter
      [pscustomobject]@{ Name = $r.Name; DisplayName = $r.DisplayName; Direction = [string]$r.Direction; Action = [string]$r.Action
        Profile = [string]$r.Profile; Enabled = [string]$r.Enabled; Program = $a.Program; Protocol = [string]$p.Protocol
        LocalPort = @($p.LocalPort); RemotePort = @($p.RemotePort) } | ConvertTo-Json -Compress | Set-Content -LiteralPath ${psq(file)} -Encoding UTF8
      Remove-NetFirewallRule -Name ${psq(item.path)} -ErrorAction Stop
      if (Get-NetFirewallRule -Name ${psq(item.path)} -ErrorAction SilentlyContinue) { 'ERR Firewall rule is still present' } else { 'OK' }`).catch((e) => `ERR ${e.message}`);
    if (/^GONE/.test(out.trim())) log(item, true, 'Already gone');
    else if (/^OK/.test(out.trim())) {
      manifest.entries.push({ kind: 'firewall', path: item.path, name: item.name, file: path.basename(file) });
      log(item, true, 'Firewall rule removed');
    } else log(item, false, out.trim().replace(/^ERR /, ''));
  }

  const values = items.filter((i) => i.kind === 'value');
  const captured = await readValues(values).catch(() => []);
  for (const item of values) {
    const v = captured.find((c) => c.path === item.path && c.name === item.name);
    if (!v) {
      log(item, true, 'Already gone');
      continue;
    }
    const r = await reg(['delete', item.path, '/v', item.name, '/f']);
    if (r.ok) manifest.entries.push({ kind: 'value', ...v });
    log(item, r.ok, r.ok ? 'Value deleted' : r.stderr);
  }

  let n = 0;
  for (const item of items.filter((i) => i.kind === 'key')) {
    if (isProtectedKey(item.path)) {
      log(item, false, 'Protected Windows key, skipped');
      continue;
    }
    const why = blocked(item);
    if (why) {
      log(item, false, `${why}, skipped`);
      continue;
    }
    const file = path.join(dir, `key-${++n}.reg`);
    const ex = await reg(['export', item.path, file, '/y']);
    if (!ex.ok) {
      log(item, /unable to find/i.test(ex.stderr), /unable to find/i.test(ex.stderr) ? 'Already gone' : `Backup failed, not deleted: ${ex.stderr}`);
      continue;
    }
    const r = await reg(['delete', item.path, '/f']);
    if (r.ok) manifest.entries.push({ kind: 'key', path: item.path, file: path.basename(file) });
    else await sys.removePath(file);
    log(item, r.ok, r.ok ? 'Key deleted' : r.stderr);
  }

  // Recreated keys (from a snapshot cleanup): only created when missing, so undo removes only ours.
  for (const item of items.filter((i) => i.kind === 'createkey')) {
    if ((await reg(['query', item.path])).ok) {
      log(item, true, 'Already exists');
      continue;
    }
    const r = await reg(['add', item.path, '/f']);
    if (r.ok) manifest.entries.push({ kind: 'newkey', path: item.path });
    log(item, r.ok, r.ok ? 'Key recreated' : r.stderr);
  }

  // Values written back from a snapshot. The current value (or its absence) is recorded first.
  const toSet = items.filter((i) => i.kind === 'setvalue');
  const current = await readValues(toSet).catch(() => []);
  for (const item of toSet) {
    const args = regAddArgs(item.path, item.name, item.valueType, item.data);
    if (!args) {
      log(item, false, 'This value type cannot be written back');
      continue;
    }
    const was = current.find((c) => c.path === item.path && c.name === item.name);
    const r = await reg(args);
    if (r.ok) manifest.entries.push(was ? { kind: 'value', ...was } : { kind: 'newvalue', path: item.path, name: item.name });
    log(item, r.ok, r.ok ? (was ? 'Earlier value put back' : 'Value recreated') : r.stderr);
  }

  for (const item of items.filter((i) => i.kind === 'dir' || i.kind === 'file')) {
    if (isProtected(item.path)) {
      log(item, false, 'Protected location, skipped');
      continue;
    }
    if (!(await sys.exists(item.path))) {
      log(item, true, 'Already gone');
      continue;
    }
    const why = blocked(item);
    if (why) {
      log(item, false, `${why}, skipped`);
      continue;
    }
    try {
      await trashItem(item.path);
      manifest.entries.push({ kind: item.kind, path: item.path, recycled: true });
      log(item, true, 'Moved to Recycle Bin');
    } catch (e) {
      log(item, false, `Could not move to Recycle Bin: ${e?.message || e}`);
    }
  }

  // Junk files: only allowed inside the known junk folders (see junk.js), moved to the Recycle Bin in one batch.
  const junk = items.filter((i) => i.kind === 'junk');
  const allowed = junk.filter((i) => isJunkPath(i.path));
  for (const item of junk.filter((i) => !isJunkPath(i.path))) log(item, false, 'Not in a junk folder, skipped');
  const errors = sys.trashMany ? await sys.trashMany(allowed.map((i) => i.path)) : await Promise.all(allowed.map((i) => trashItem(i.path).then(() => '', (e) => String(e?.message || e))));
  allowed.forEach((item, i) => {
    if (!errors[i]) {
      manifest.entries.push({ kind: item.dir ? 'dir' : 'file', path: item.path, recycled: true });
      log(item, true, 'Moved to Recycle Bin');
    } else log(item, false, /being used|in use|access is denied|0x80070020|0x80070005/i.test(errors[i]) ? 'In use, skipped' : errors[i]);
  });

  // Keep a backup only when something was actually removed.
  if (!manifest.entries.length) {
    await sys.removePath(dir);
    return { backupId: null, results };
  }
  await sys.writeText(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { backupId: id, results };
}

async function list() {
  const dirs = (await sys.readDir(backupRoot).catch(() => [])).filter((d) => d.dir);
  const manifests = await Promise.all(
    dirs.map((d) =>
      sys
        .readText(path.join(backupRoot, d.name, 'manifest.json'))
        .then(JSON.parse)
        .catch(() => null)
    )
  );
  return manifests.filter(Boolean).sort((a, b) => b.created.localeCompare(a.created));
}

// Moves the newest Recycle Bin copy of each original path back into place, in one pass. Each
// recycled item has a $I record holding its original path (format 2: path length at byte 24,
// UTF-16 path from 28; format 1: fixed 520-byte path from 24) next to the $R item itself.
// Resolves to { [original]: 'OK' | 'EXISTS' | 'NOTFOUND' | error text }.
async function restoreManyFromRecycleBin(originals) {
  if (!originals.length) return {};
  const out = await runPS(
    `$wanted = @([Console]::In.ReadToEnd() | ConvertFrom-Json)
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $index = @{}
    foreach ($root in @($wanted | ForEach-Object { [IO.Path]::GetPathRoot([string]$_) } | Sort-Object -Unique)) {
      $bin = Join-Path $root ('$Recycle.Bin\\' + $sid)
      foreach ($i in Get-ChildItem -LiteralPath $bin -Filter '$I*' -Force -ErrorAction SilentlyContinue) {
        try { $b = [IO.File]::ReadAllBytes($i.FullName) } catch { continue }
        if ($b.Length -lt 28) { continue }
        if ([BitConverter]::ToInt64($b, 0) -eq 2) { $len = [BitConverter]::ToInt32($b, 24); $p = [Text.Encoding]::Unicode.GetString($b, 28, [Math]::Max(0, $len - 1) * 2) }
        else { $p = [Text.Encoding]::Unicode.GetString($b, 24, [Math]::Min(520, $b.Length - 24)).TrimEnd([char]0) }
        $t = [BitConverter]::ToInt64($b, 16); $k = $p.ToLowerInvariant()
        if (-not $index.ContainsKey($k) -or $index[$k].Time -lt $t) { $index[$k] = @{ Info = $i; Time = $t; Bin = $bin } }
      }
    }
    # The Recycle Bin records long paths; paths built from %TEMP% can hold 8.3 short names (SEANSH~1).
    if (@($wanted) -match '~') { Add-Type -Namespace SweepUninstall -Name LongPath -MemberDefinition '[DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern uint GetLongPathName(string s, System.Text.StringBuilder b, uint n);' }
    function Get-LongPath([string]$p) {
      if ($p -notmatch '~') { return $p }
      $tail = ''; $head = $p
      while ($head -and -not (Test-Path -LiteralPath $head)) { $tail = '\\' + (Split-Path -Leaf $head) + $tail; $head = Split-Path -Parent $head }
      $sb = New-Object Text.StringBuilder 1024
      if ($head -and [SweepUninstall.LongPath]::GetLongPathName($head, $sb, 1024) -gt 0) { return $sb.ToString() + $tail }
      $p
    }
    $result = @{}
    foreach ($w in $wanted) {
      $orig = [string]$w
      try {
        if (Test-Path -LiteralPath $orig) { $result[$orig] = 'EXISTS'; continue }
        $hit = $index[(Get-LongPath $orig).ToLowerInvariant()]
        if (-not $hit) { $result[$orig] = 'NOTFOUND'; continue }
        $item = Join-Path $hit.Bin ('$R' + $hit.Info.Name.Substring(2))
        if (-not (Test-Path -LiteralPath $item)) { $result[$orig] = 'NOTFOUND'; continue }
        $parent = Split-Path -Parent $orig
        if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
        Move-Item -LiteralPath $item -Destination $orig -ErrorAction Stop
        Remove-Item -LiteralPath $hit.Info.FullName -Force -ErrorAction SilentlyContinue
        $result[$orig] = if (Test-Path -LiteralPath $orig) { 'OK' } else { 'Could not move it back' }
      } catch { $result[$orig] = $_.Exception.Message }
    }
    $result | ConvertTo-Json -Compress`,
    { input: JSON.stringify(originals) }
  );
  return JSON.parse(out.trim() || '{}');
}

const restoreFromRecycleBin = async (original) => (await restoreManyFromRecycleBin([original]))[original] || 'NOTFOUND';

async function restore(id) {
  const dir = path.join(backupRoot, id);
  const manifest = JSON.parse(await sys.readText(path.join(dir, 'manifest.json')));
  const results = [];
  const recycled = await restoreManyFromRecycleBin(manifest.entries.filter((e) => e.recycled).map((e) => e.path)).catch((err) => ({ error: `ERR ${err.message}` }));
  for (const e of manifest.entries) {
    if (e.kind === 'key') {
      const r = await reg(['import', path.join(dir, e.file)]);
      results.push({ ...e, ok: r.ok, detail: r.ok ? 'Key restored' : r.stderr });
    } else if (e.kind === 'newvalue') {
      let r = await reg(['delete', e.path, ...(e.name ? ['/v', e.name] : ['/ve']), '/f']);
      if (!r.ok && /unable to find/i.test(r.stderr)) r = { ok: true };
      results.push({ ...e, kind: 'value', ok: r.ok, detail: r.ok ? 'Recreated value removed again' : r.stderr });
    } else if (e.kind === 'newkey') {
      // Only keys SweepUninstall itself created are removed again, and never a protected one.
      let r = isProtectedKey(e.path) ? { ok: false, stderr: 'Protected Windows key, left in place' } : await reg(['delete', e.path, '/f']);
      if (!r.ok && /unable to find/i.test(r.stderr)) r = { ok: true };
      results.push({ ...e, kind: 'key', ok: r.ok, detail: r.ok ? 'Recreated key removed again' : r.stderr });
    } else if (e.kind === 'value') {
      const r = await reg(['add', e.path, '/v', e.name, '/t', REG_TYPE[e.valueKind] || 'REG_SZ', '/d', e.data, '/f']);
      results.push({ ...e, ok: r.ok, detail: r.ok ? 'Value restored' : r.stderr });
    } else if (e.kind === 'service' && e.file) {
      const r = await reg(['import', path.join(dir, e.file)]);
      results.push({ ...e, ok: r.ok, detail: r.ok ? 'Service restored; restart Windows to start it' : r.stderr });
    } else if (e.kind === 'task') {
      const split = e.path.lastIndexOf('\\') + 1;
      // Success is confirmed by finding the task again, not by the command merely finishing.
      const out = await runPS(`
        $ErrorActionPreference = 'Stop'
        Register-ScheduledTask -Xml (Get-Content -LiteralPath ${psq(path.join(dir, e.file))} -Raw) -TaskName ${psq(e.path.slice(split))} -TaskPath ${psq(e.path.slice(0, split))} -Force | Out-Null
        if (Get-ScheduledTask -TaskName ${psq(e.path.slice(split))} -TaskPath ${psq(e.path.slice(0, split))} -ErrorAction SilentlyContinue) { 'OK' } else { 'Task was not recreated' }`
      ).catch((err) => err.message);
      results.push({ ...e, ok: /^OK/.test(out.trim()), detail: /^OK/.test(out.trim()) ? 'Task restored' : out.trim() });
    } else if (e.kind === 'firewall') {
      const out = await runPS(`
        $ErrorActionPreference = 'Stop'
        $r = Get-Content -LiteralPath ${psq(path.join(dir, e.file))} -Raw | ConvertFrom-Json
        $params = @{ Name = $r.Name; DisplayName = $r.DisplayName; Direction = $r.Direction; Action = $r.Action; Enabled = $r.Enabled; Profile = ($r.Profile -split ',\\s*') }
        if ($r.Program -and $r.Program -ne 'Any') { $params.Program = $r.Program }
        if ($r.Protocol -and $r.Protocol -ne 'Any') { $params.Protocol = $r.Protocol
          if (@($r.LocalPort) -notcontains 'Any') { $params.LocalPort = @($r.LocalPort) }
          if (@($r.RemotePort) -notcontains 'Any') { $params.RemotePort = @($r.RemotePort) } }
        New-NetFirewallRule @params | Out-Null
        if (Get-NetFirewallRule -Name $r.Name -ErrorAction SilentlyContinue) { 'OK' } else { 'Firewall rule was not recreated' }`).catch((err) => err.message);
      results.push({ ...e, ok: /^OK/.test(out.trim()), detail: /^OK/.test(out.trim()) ? 'Firewall rule restored' : out.trim() });
    } else if (e.recycled) {
      const out = String(recycled[e.path] || recycled.error || 'NOTFOUND').trim();
      const detail = { OK: 'Restored from the Recycle Bin', EXISTS: 'Already back in place', NOTFOUND: 'Not in the Recycle Bin any more (it may have been emptied)' }[out] || out.replace(/^ERR /, '');
      results.push({ ...e, ok: out === 'OK' || out === 'EXISTS', detail });
    } else {
      results.push({ ...e, ok: false, detail: 'Not restorable' });
    }
  }
  return results;
}

// Deletes one backup folder. The id must be a single folder name inside the backup root.
function remove(id) {
  if (!id || /[\\/]|\.\./.test(id)) throw new Error('Invalid backup id');
  return sys.removePath(path.join(backupRoot, id));
}

export { setRoot, removeItems, list, restore, remove, restoreFromRecycleBin };
