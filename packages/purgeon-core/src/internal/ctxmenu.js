// Explorer right-click entries added by programs, turned on and off without deleting anything:
// - menu commands (…\shell\<name>) are switched off with Windows' own LegacyDisable value, written
//   where the entry itself lives (per-user entries need no administrator rights);
// - shell extensions (…\shellex\ContextMenuHandlers) are switched off by listing them in Windows'
//   "Shell Extensions\Blocked" list (administrator only).
// Windows' own entries (programs in the Windows folder) are not listed.
import { runPSJson, reg } from './shell.js';

const PLACES = [
  ['*', 'Files'],
  ['AllFilesystemObjects', 'Files and folders'],
  ['Directory', 'Folders'],
  ['Directory\\Background', 'Folder background'],
  ['DesktopBackground', 'Desktop background'],
  ['Drive', 'Drives'],
  ['Folder', 'Folders and libraries'],
];
const BLOCKED = 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Shell Extensions\\Blocked';

const LIST = `
$in = [Console]::In.ReadToEnd() | ConvertFrom-Json
$blocked = Get-Item -LiteralPath 'Registry::${BLOCKED}' -ErrorAction SilentlyContinue
$blockedNames = if ($blocked) { @($blocked.GetValueNames()) } else { @() }
function Exe($cmd) {
  if (-not $cmd) { return '' }
  $e = if ($cmd -match '^\\s*"([^"]+)"') { $matches[1] } elseif ($cmd -match '^\\s*(\\S+\\.(exe|dll))') { $matches[1] } else { ($cmd -split ' ')[0] }
  [Environment]::ExpandEnvironmentVariables($e)
}
function IsWindows($file) { $file -match '^\\W*([a-z]:\\\\windows\\\\|%systemroot%|\\\\systemroot\\\\|system32\\\\)' -or -not $file }
function Company($file) { if ($file -and (Test-Path -LiteralPath $file -PathType Leaf)) { try { return [string](Get-Item -LiteralPath $file).VersionInfo.CompanyName } catch {} }; '' }
$out = New-Object System.Collections.ArrayList
foreach ($p in $in) {
  foreach ($hive in @(@('HKEY_CURRENT_USER\\Software\\Classes', 'user'), @('HKEY_LOCAL_MACHINE\\SOFTWARE\\Classes', 'machine'))) {
    $base = "$($hive[0])\\$($p.id)"
    foreach ($k in Get-ChildItem -LiteralPath "Registry::$base\\shell" -ErrorAction SilentlyContinue) {
      $v = Get-ItemProperty -LiteralPath $k.PSPath -ErrorAction SilentlyContinue
      $cmd = [string](Get-ItemProperty -LiteralPath "$($k.PSPath)\\command" -ErrorAction SilentlyContinue).'(default)'
      $exe = Exe $cmd
      if (IsWindows $exe) { continue }
      if ($v.ProgrammaticAccessOnly -ne $null) { continue }
      $label = [string]$v.MUIVerb; if (-not $label) { $label = [string]$v.'(default)' }; if (-not $label -or $label.StartsWith('@')) { $label = $k.PSChildName }
      [void]$out.Add([pscustomobject]@{ type = 'verb'; place = $p.label; scope = $hive[1]; key = $k.Name; name = ($label -replace '&', ''); file = $exe; company = (Company $exe); enabled = ($v.PSObject.Properties.Name -notcontains 'LegacyDisable') })
    }
    foreach ($k in Get-ChildItem -LiteralPath "Registry::$base\\shellex\\ContextMenuHandlers" -ErrorAction SilentlyContinue) {
      $clsid = [string](Get-ItemProperty -LiteralPath $k.PSPath -ErrorAction SilentlyContinue).'(default)'
      if ($clsid -notmatch '^\\{[0-9A-Fa-f-]{36}\\}$') { $clsid = $k.PSChildName }
      if ($clsid -notmatch '^\\{[0-9A-Fa-f-]{36}\\}$') { continue }
      $dll = [string](Get-ItemProperty -LiteralPath "Registry::HKEY_CLASSES_ROOT\\CLSID\\$clsid\\InprocServer32" -ErrorAction SilentlyContinue).'(default)'
      $dll = [Environment]::ExpandEnvironmentVariables($dll.Trim('"'))
      if (IsWindows $dll) { continue }
      $label = [string](Get-ItemProperty -LiteralPath "Registry::HKEY_CLASSES_ROOT\\CLSID\\$clsid" -ErrorAction SilentlyContinue).'(default)'
      if (-not $label) { $label = $k.PSChildName }
      if ($label -match '^\\{' -and $dll -and (Test-Path -LiteralPath $dll)) { try { $d = (Get-Item -LiteralPath $dll).VersionInfo.FileDescription; $label = if ($d) { $d } else { [IO.Path]::GetFileNameWithoutExtension($dll) } } catch {} }
      [void]$out.Add([pscustomobject]@{ type = 'extension'; place = $p.label; scope = $hive[1]; key = $k.Name; clsid = $clsid; name = $label; file = $dll; company = (Company $dll); enabled = ($blockedNames -notcontains $clsid) })
    }
  }
}
@($out) | ConvertTo-Json -Compress
`;

// [{ id, type: 'verb' | 'extension', place, scope, key, clsid?, name, file, company, enabled, admin }]
export async function list() {
  const rows = await runPSJson(LIST, { input: JSON.stringify(PLACES.map(([id, label]) => ({ id, label }))) });
  const seen = new Set();
  return rows
    .map((r) => ({ ...r, id: r.type === 'extension' ? `ext|${r.clsid}` : `verb|${r.key}`, admin: r.type === 'extension' || r.scope === 'machine', windows: /^Microsoft/i.test(r.company || '') }))
    .filter((r) => !seen.has(r.id) && seen.add(r.id))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Turns one entry on or off. Returns the entry as it is now.
export async function set(entry, enable) {
  if (entry.type === 'verb') {
    if (!/\\shell\\[^\\]+$/i.test(entry.key) || !/^HKEY_(CURRENT_USER\\Software|LOCAL_MACHINE\\SOFTWARE)\\Classes\\/i.test(entry.key)) throw new Error('Not a context menu entry.');
    const r = enable ? await reg(['delete', entry.key, '/v', 'LegacyDisable', '/f']) : await reg(['add', entry.key, '/v', 'LegacyDisable', '/t', 'REG_SZ', '/d', '', '/f']);
    if (!r.ok && !(enable && /unable to find/i.test(r.stderr))) throw new Error(/access is denied/i.test(r.stderr) ? `"${entry.name}" is set for all users and needs administrator rights.` : r.stderr.trim());
  } else {
    if (!/^\{[0-9a-f-]{36}\}$/i.test(entry.clsid || '')) throw new Error('Not a shell extension.');
    const r = enable ? await reg(['delete', BLOCKED, '/v', entry.clsid, '/f']) : await reg(['add', BLOCKED, '/v', entry.clsid, '/t', 'REG_SZ', '/d', `${entry.name} (turned off by Purgeon)`, '/f']);
    if (!r.ok && !(enable && /unable to find/i.test(r.stderr))) throw new Error(/access is denied/i.test(r.stderr) ? 'Shell extensions are turned off for all users and need administrator rights.' : r.stderr.trim());
  }
  return { ...entry, enabled: enable };
}
