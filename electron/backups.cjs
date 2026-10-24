// Backs up and removes leftover items, and restores backups.
// Registry keys are exported to .reg files, values are recorded with their type and data,
// and files go to the Recycle Bin, so every removal can be undone.
const fs = require('fs');
const path = require('path');
const { reg, runPS, runPSJson, psq } = require('./shell.cjs');
const { isProtected } = require('./paths.cjs');

let backupRoot = '';
const setRoot = (dir) => {
  backupRoot = dir;
  fs.mkdirSync(backupRoot, { recursive: true });
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

async function removeItems({ title, items, trashItem }) {
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}_${slug(title)}`;
  const dir = path.join(backupRoot, id);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = { id, title, created: new Date().toISOString(), entries: [] };
  const results = [];
  const log = (item, ok, detail) => results.push({ ...item, ok, detail });

  // Services first, so their files are no longer locked. The service's registry definition is
  // exported first; importing it back recreates the service after a reboot.
  let s = 0;
  for (const item of items.filter((i) => i.kind === 'service')) {
    const file = path.join(dir, `service-${++s}.reg`);
    const ex = await reg(['export', `HKLM\\SYSTEM\\CurrentControlSet\\Services\\${item.path}`, file, '/y']);
    if (!ex.ok) {
      log(item, /unable to find/i.test(ex.stderr), /unable to find/i.test(ex.stderr) ? 'Already gone' : `Backup failed, not deleted: ${ex.stderr}`);
      continue;
    }
    await runPS(`Stop-Service -Name ${psq(item.path)} -Force -ErrorAction SilentlyContinue`).catch(() => {});
    const r = await new Promise((res) =>
      require('child_process').execFile('sc.exe', ['delete', item.path], { windowsHide: true }, (e, out) => res({ ok: !e, out }))
    );
    if (r.ok) manifest.entries.push({ kind: 'service', path: item.path, file: path.basename(file) });
    log(item, r.ok, r.ok ? 'Service deleted' : r.out);
  }

  // Scheduled tasks: exported to XML, then unregistered.
  let t = 0;
  for (const item of items.filter((i) => i.kind === 'task')) {
    const file = path.join(dir, `task-${++t}.xml`);
    const out = await runPS(`
      $t = Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { ($_.TaskPath + $_.TaskName) -eq ${psq(item.path)} } | Select-Object -First 1
      if (-not $t) { 'GONE'; return }
      Export-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath | Set-Content -LiteralPath ${psq(file)} -Encoding Unicode
      Unregister-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath -Confirm:$false -ErrorAction Stop
      'OK'`).catch((e) => `ERR ${e.message}`);
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
      'OK'`).catch((e) => `ERR ${e.message}`);
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
    const file = path.join(dir, `key-${++n}.reg`);
    const ex = await reg(['export', item.path, file, '/y']);
    if (!ex.ok) {
      log(item, /unable to find/i.test(ex.stderr), /unable to find/i.test(ex.stderr) ? 'Already gone' : `Backup failed, not deleted: ${ex.stderr}`);
      continue;
    }
    const r = await reg(['delete', item.path, '/f']);
    if (r.ok) manifest.entries.push({ kind: 'key', path: item.path, file: path.basename(file) });
    else fs.rmSync(file, { force: true });
    log(item, r.ok, r.ok ? 'Key deleted' : r.stderr);
  }

  for (const item of items.filter((i) => i.kind === 'dir' || i.kind === 'file')) {
    if (isProtected(item.path)) {
      log(item, false, 'Protected location, skipped');
      continue;
    }
    if (!fs.existsSync(item.path)) {
      log(item, true, 'Already gone');
      continue;
    }
    try {
      await trashItem(item.path);
      manifest.entries.push({ kind: item.kind, path: item.path, recycled: true });
      log(item, true, 'Moved to Recycle Bin');
    } catch (e) {
      log(item, false, `Could not move to Recycle Bin: ${e.message}`);
    }
  }

  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { backupId: id, results };
}

function list() {
  if (!fs.existsSync(backupRoot)) return [];
  return fs
    .readdirSync(backupRoot)
    .map((id) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(backupRoot, id, 'manifest.json'), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.created.localeCompare(a.created));
}

async function restore(id) {
  const dir = path.join(backupRoot, id);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const results = [];
  for (const e of manifest.entries) {
    if (e.kind === 'key') {
      const r = await reg(['import', path.join(dir, e.file)]);
      results.push({ ...e, ok: r.ok, detail: r.ok ? 'Key restored' : r.stderr });
    } else if (e.kind === 'value') {
      const r = await reg(['add', e.path, '/v', e.name, '/t', REG_TYPE[e.valueKind] || 'REG_SZ', '/d', e.data, '/f']);
      results.push({ ...e, ok: r.ok, detail: r.ok ? 'Value restored' : r.stderr });
    } else if (e.kind === 'service' && e.file) {
      const r = await reg(['import', path.join(dir, e.file)]);
      results.push({ ...e, ok: r.ok, detail: r.ok ? 'Service restored; restart Windows to start it' : r.stderr });
    } else if (e.kind === 'task') {
      const split = e.path.lastIndexOf('\\') + 1;
      const out = await runPS(
        `Register-ScheduledTask -Xml (Get-Content -LiteralPath ${psq(path.join(dir, e.file))} -Raw) -TaskName ${psq(e.path.slice(split))} -TaskPath ${psq(e.path.slice(0, split))} -Force -ErrorAction Stop | Out-Null; 'OK'`
      ).catch((err) => err.message);
      results.push({ ...e, ok: /^OK/.test(out.trim()), detail: /^OK/.test(out.trim()) ? 'Task restored' : out.trim() });
    } else if (e.kind === 'firewall') {
      const out = await runPS(`
        $r = Get-Content -LiteralPath ${psq(path.join(dir, e.file))} -Raw | ConvertFrom-Json
        $params = @{ Name = $r.Name; DisplayName = $r.DisplayName; Direction = $r.Direction; Action = $r.Action; Enabled = $r.Enabled; Profile = ($r.Profile -split ',\\s*') }
        if ($r.Program -and $r.Program -ne 'Any') { $params.Program = $r.Program }
        if ($r.Protocol -and $r.Protocol -ne 'Any') { $params.Protocol = $r.Protocol
          if (@($r.LocalPort) -notcontains 'Any') { $params.LocalPort = @($r.LocalPort) }
          if (@($r.RemotePort) -notcontains 'Any') { $params.RemotePort = @($r.RemotePort) } }
        New-NetFirewallRule @args -ErrorAction Stop | Out-Null; 'OK'`).catch((err) => err.message);
      results.push({ ...e, ok: /^OK/.test(out.trim()), detail: /^OK/.test(out.trim()) ? 'Firewall rule restored' : out.trim() });
    } else if (e.recycled) {
      results.push({ ...e, ok: false, detail: 'Restore from the Recycle Bin' });
    } else {
      results.push({ ...e, ok: false, detail: 'Not restorable' });
    }
  }
  return results;
}

function remove(id) {
  fs.rmSync(path.join(backupRoot, id), { recursive: true, force: true });
}

module.exports = { setRoot, removeItems, list, restore, remove };
