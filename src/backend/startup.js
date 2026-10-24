import { sys, env } from './sys.js';
import * as path from './winpath.js';
// Startup manager: programs that start with Windows (Run keys, Startup folders), scheduled
// tasks outside \Microsoft\, and third-party services. Turning an entry off never deletes it:
// - Run keys and Startup folders use Windows' own StartupApproved switches (as Task Manager does)
// - Scheduled tasks are disabled with Disable-ScheduledTask
// - Services that start automatically are set to Manual; their original start mode is remembered
import { runPS, runPSJson, reg, psq, execFile } from './shell.js';

const APPROVED = 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved';
// Run-key locations and the StartupApproved key Windows uses for each.
const RUN_KEYS = [
  { id: 'hkcu-run', key: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', approved: `HKCU\\${APPROVED}\\Run`, label: 'Run (current user)' },
  { id: 'hklm-run', key: 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run', approved: `HKLM\\${APPROVED}\\Run`, label: 'Run (all users)', admin: true },
  { id: 'hklm-run32', key: 'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Run', approved: `HKLM\\${APPROVED}\\Run32`, label: 'Run (all users, 32-bit)', admin: true },
];
const STARTUP_FOLDERS = [
  { id: 'user-folder', dir: () => path.join(env('APPDATA'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'), approved: `HKCU\\${APPROVED}\\StartupFolder`, label: 'Startup folder (current user)' },
  { id: 'common-folder', dir: () => path.join(env('ProgramData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'), approved: `HKLM\\${APPROVED}\\StartupFolder`, label: 'Startup folder (all users)', admin: true },
];

let stateFile = '';
const setRoot = async (dir) => {
  await sys.makeDir(dir);
  stateFile = path.join(dir, 'startup-state.json');
};
const readState = () => sys.readText(stateFile).then(JSON.parse).catch(() => ({ services: {} }));
const writeState = (s) => sys.writeText(stateFile, JSON.stringify(s, null, 2));

// StartupApproved values are 12 bytes; an odd first byte means "disabled".
const approvedEnabled = (hex) => !hex || parseInt(hex.slice(0, 2), 16) % 2 === 0;

const LIST = `
$in = [Console]::In.ReadToEnd() | ConvertFrom-Json
function Company($cmd) {
  if (-not $cmd) { return '' }
  $exe = if ($cmd -match '^\\s*"([^"]+)"') { $matches[1] } elseif ($cmd -match '^\\s*(\\S+\\.(exe|com|bat|cmd))') { $matches[1] } else { ($cmd -split ' ')[0] }
  $exe = [Environment]::ExpandEnvironmentVariables($exe)
  if (Test-Path -LiteralPath $exe -PathType Leaf) { try { return [string](Get-Item -LiteralPath $exe).VersionInfo.CompanyName } catch {} }
  return ''
}
function Approved($key, $name) {
  $k = Get-Item -LiteralPath "Registry::$key" -ErrorAction SilentlyContinue
  if (-not $k) { return '' }
  $v = $k.GetValue($name, $null)
  if ($v -is [byte[]]) { return ($v | ForEach-Object { $_.ToString('x2') }) -join '' }
  return ''
}
# A service can be reconfigured only when it isn't protected (PPL) and Administrators hold the
# "change configuration" right (DC, or generic all/write) with no deny entry for it.
function Changeable($name) {
  $prot = (& sc.exe qprotection $name 2>$null | Out-String)
  if ($prot -notmatch 'PROTECTION LEVEL:\\s*NONE') { return $false }
  $sd = (& sc.exe sdshow $name 2>$null | Out-String).Trim()
  $allow = $false
  foreach ($ace in [regex]::Matches($sd, '\\(([AD]);[^;]*;([^;]*);[^;]*;[^;]*;BA\\)')) {
    $rights = @([regex]::Matches($ace.Groups[2].Value, '..') | ForEach-Object { $_.Value })
    $grants = ($rights -contains 'DC') -or ($rights -contains 'GA') -or ($rights -contains 'GW')
    if ($grants -and $ace.Groups[1].Value -eq 'D') { return $false }
    if ($grants) { $allow = $true }
  }
  return $allow
}
$out = New-Object System.Collections.ArrayList

foreach ($r in $in.runKeys) {
  $k = Get-Item -LiteralPath "Registry::$($r.key)" -ErrorAction SilentlyContinue
  if (-not $k) { continue }
  foreach ($n in $k.GetValueNames()) {
    if (-not $n) { continue }
    $cmd = [string]$k.GetValue($n, '', 'DoNotExpandEnvironmentNames')
    [void]$out.Add([pscustomobject]@{ type = 'run'; source = $r.id; name = $n; command = $cmd; approved = (Approved $r.approved $n); company = (Company $cmd) })
  }
}
foreach ($f in $in.folders) {
  if (-not (Test-Path -LiteralPath $f.dir)) { continue }
  foreach ($file in Get-ChildItem -LiteralPath $f.dir -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne 'desktop.ini' }) {
    $target = $file.FullName
    if ($file.Extension -eq '.lnk') { try { $target = (New-Object -ComObject WScript.Shell).CreateShortcut($file.FullName).TargetPath } catch {} }
    [void]$out.Add([pscustomobject]@{ type = 'folder'; source = $f.id; name = $file.Name; command = $target; approved = (Approved $f.approved $file.Name); company = (Company "\`"$target\`"") })
  }
}
foreach ($t in Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskPath -notlike '\\Microsoft\\*' }) {
  $a = @($t.Actions)[0]
  $cmd = if ($a.Execute) { ('"' + $a.Execute + '" ' + $a.Arguments).Trim() } else { '' }
  $triggers = (@($t.Triggers) | ForEach-Object { ($_.CimClass.CimClassName -replace '^MSFT_Task|Trigger$','') }) -join ', '
  [void]$out.Add([pscustomobject]@{ type = 'task'; source = 'task'; name = $t.TaskName; path = "$($t.TaskPath)$($t.TaskName)"; command = $cmd; enabled = ($t.State -ne 'Disabled'); triggers = $triggers; company = (Company $cmd) })
}
$managed = @($in.managedServices)
foreach ($s in Get-CimInstance Win32_Service -ErrorAction SilentlyContinue) {
  $isManaged = $managed -contains $s.Name
  if (-not $isManaged -and $s.StartMode -ne 'Auto') { continue }
  if (-not $s.PathName) { continue }
  $company = Company $s.PathName
  if (-not $isManaged -and ($company -match '^Microsoft' -or $s.PathName -match '\\\\Windows\\\\(System32|SysWOW64)\\\\(svchost|lsass|services)\\.exe')) { continue }
  if (-not $isManaged -and -not $company -and $s.PathName -match '^\\W*[a-z]:\\\\Windows\\\\') { continue }
  # Only services SweepUninstall can actually change (ones it already switched stay listed).
  if (-not $isManaged -and -not (Changeable $s.Name)) { continue }
  [void]$out.Add([pscustomobject]@{ type = 'service'; source = 'service'; name = $s.Name; display = $s.DisplayName; command = $s.PathName; startMode = $s.StartMode; state = $s.State; company = $company })
}
@($out) | ConvertTo-Json -Compress -Depth 3
`;

async function list() {
  const state = await readState();
  const input = JSON.stringify({
    runKeys: RUN_KEYS.map(({ id, key, approved }) => ({ id, key: key.replace(/^HKCU/, 'HKEY_CURRENT_USER').replace(/^HKLM/, 'HKEY_LOCAL_MACHINE'), approved: approved.replace(/^HKCU/, 'HKEY_CURRENT_USER').replace(/^HKLM/, 'HKEY_LOCAL_MACHINE') })),
    folders: STARTUP_FOLDERS.map(({ id, dir, approved }) => ({ id, dir: dir(), approved: approved.replace(/^HKCU/, 'HKEY_CURRENT_USER').replace(/^HKLM/, 'HKEY_LOCAL_MACHINE') })),
    managedServices: Object.keys(state.services || {}),
  });
  const rows = await runPSJson(LIST, { input });
  return rows.map((r) => ({ ...shape(r, state), windows: /^Microsoft/i.test(r.company || '') }));
}

// Adds the id, on/off state, location text and admin/effect hints the UI shows.
function shape(r, state) {
  const src = [...RUN_KEYS, ...STARTUP_FOLDERS].find((s) => s.id === r.source);
  if (r.type === 'run' || r.type === 'folder') {
    return { ...r, id: `${r.source}|${r.name}`, enabled: approvedEnabled(r.approved), where: src.label, admin: !!src.admin, effect: 'signin' };
  }
  // Tasks you created can often be toggled without admin, so they are tried rather than blocked.
  if (r.type === 'task') return { ...r, id: `task|${r.path}`, where: `Task ${r.path}${r.triggers ? ` (${r.triggers.replace(/^,\s*/, '')})` : ''}`, admin: false, effect: 'signin' };
  const remembered = state.services?.[r.name];
  return {
    ...r,
    id: `service|${r.name}`,
    name: r.display || r.name,
    serviceName: r.name,
    enabled: r.startMode === 'Auto',
    where: `Service ${r.name} · ${r.startMode === 'Auto' ? 'Automatic' : r.startMode}${remembered ? ` (was ${remembered})` : ''}`,
    admin: true,
    effect: 'reboot',
  };
}

const hexEnabled = '020000000000000000000000';
const hexDisabled = '030000000000000000000000';

async function setEnabled(entry, enable) {
  const denied = (msg) => (/access is denied|0x80070005|PermissionDenied/i.test(msg || '') ? `"${entry.name}" needs administrator rights. Use File › Restart as Administrator.` : msg);
  if (entry.type === 'run' || entry.type === 'folder') {
    const src = [...RUN_KEYS, ...STARTUP_FOLDERS].find((s) => s.id === entry.source);
    const r = await reg(['add', src.approved, '/v', entry.name, '/t', 'REG_BINARY', '/d', enable ? hexEnabled : hexDisabled, '/f']);
    if (!r.ok) throw new Error(denied(r.stderr.trim()));
    return;
  }
  if (entry.type === 'task') {
    const split = entry.path.lastIndexOf('\\') + 1;
    await runPS(`${enable ? 'Enable' : 'Disable'}-ScheduledTask -TaskPath ${psq(entry.path.slice(0, split))} -TaskName ${psq(entry.path.slice(split))} -ErrorAction Stop | Out-Null`).catch((e) => {
      throw new Error(denied(e.message));
    });
    return;
  }
  if (entry.type === 'service') {
    const state = await readState();
    state.services = state.services || {};
    let mode;
    if (enable) {
      mode = state.services[entry.serviceName] === 'Automatic (delayed)' ? 'delayed-auto' : 'auto';
    } else {
      const delayed = (await runPS(`(Get-ItemProperty -LiteralPath ${psq(`Registry::HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\${entry.serviceName}`)} -ErrorAction SilentlyContinue).DelayedAutostart`).catch(() => '')).trim() === '1';
      state.services[entry.serviceName] = delayed ? 'Automatic (delayed)' : 'Automatic';
      mode = 'demand';
    }
    const r = await execFile('sc.exe', ['config', entry.serviceName, 'start=', mode]);
    if (!r.ok) throw new Error(denied(r.out.trim()));
    if (enable) delete state.services[entry.serviceName];
    await writeState(state);
    return;
  }
  throw new Error(`Unknown startup entry type ${entry.type}`);
}

export { setRoot, list, setEnabled, approvedEnabled };
