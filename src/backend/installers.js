// What each installer technology tells us about a program:
// - which technology installed it (Windows Installer, Inno Setup, NSIS, WiX bundle...),
// - how to run its uninstaller silently, when that is known to be supported,
// - the exact files and settings it installed, read from the installer's own records:
//   the Windows Installer package cached for the product, or the Inno Setup uninstall log.
// Those records disappear during uninstall, so the uninstall flow reads them first.
import { sys } from './sys.js';
import * as path from './winpath.js';
import { runPS, runPSJson, psq } from './shell.js';
import { isProtected, isProtectedKey } from './paths.js';

const GUID = /\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}/i;
const leaf = (key) => String(key || '').split('\\').pop();

// The uninstaller exe from an uninstall command line ("C:\x\unins000.exe" /args or C:\x\uninst.exe /args).
export function uninstallerExe(commandLine) {
  const s = String(commandLine || '').trim();
  const m = s.match(/^"([^"]+)"/) || s.match(/^(.+?\.exe)(?=\s|$)/i);
  return m ? m[1] : '';
}

// Technology and silent command from the registry entry alone.
export function detect(p) {
  const u = String(p.uninstall || '');
  const exe = uninstallerExe(u);
  const product = (GUID.test(leaf(p.key)) && leaf(p.key).match(GUID)[0]) || (u.match(GUID) || [])[0] || '';
  if (/msiexec/i.test(u) && product) return { type: 'msi', label: 'Windows Installer', product, silent: `MsiExec.exe /X${product} /qn /norestart` };
  if (/_is1$/i.test(leaf(p.key)) || /\\unins\d{3}\.exe$/i.test(exe)) return { type: 'inno', label: 'Inno Setup', exe, silent: `"${exe}" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART` };
  if (/\\Package Cache\\/i.test(exe) && /\/uninstall\b/i.test(u)) return { type: 'wix', label: 'WiX bundle', exe, silent: `${u.replace(/\s+\/(quiet|passive)\b/gi, '')} /quiet /norestart` };
  if (/InstallShield Installation Information/i.test(u)) return { type: 'installshield', label: 'InstallShield', exe, silent: '' };
  return { type: 'unknown', label: '', exe, silent: '' };
}

// Like detect, but also looks inside the uninstaller to recognise NSIS, and prefers a quiet
// command the publisher registered. { type, label, silent } where silent is '' when not known.
export async function describe(p) {
  const d = detect(p);
  if (p.quiet) return { ...d, label: d.label || 'Publisher-provided', silent: p.quiet, publisherQuiet: true };
  if (d.type === 'unknown' && d.exe && /\.exe$/i.test(d.exe)) {
    const nsis = await runPS(
      `$f = ${psq(d.exe)}
       if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { 'NO'; return }
       $s = [IO.File]::OpenRead($f); $n = [Math]::Min($s.Length, 4MB); $b = New-Object byte[] $n; [void]$s.Read($b, 0, $n); $s.Close()
       if ([Text.Encoding]::ASCII.GetString($b) -match 'Nullsoft\\.NSIS|NullsoftInst') { 'NSIS' } else { 'NO' }`
    ).catch(() => 'NO');
    if (/NSIS/.test(nsis)) return { ...d, type: 'nsis', label: 'NSIS', silent: `"${d.exe}" /S` };
  }
  return d;
}

// ---- files and settings listed by the installer --------------------------------

// Every component of a Windows Installer product, resolved to its installed key path through
// the product's cached package. Registry key paths look like "02:\SOFTWARE\X\Value".
const MSI_PATHS = `
$pc = [Console]::In.ReadToEnd().Trim()
$i = New-Object -ComObject WindowsInstaller.Installer
function Call($o, $m, $kind, $a) { $o.GetType().InvokeMember($m, $kind, $null, $o, $a) }
try { $pkg = Call $i 'ProductInfo' 'GetProperty' @($pc, 'LocalPackage') } catch { '[]'; return }
if (-not $pkg -or -not (Test-Path -LiteralPath $pkg)) { '[]'; return }
$db = Call $i 'OpenDatabase' 'InvokeMethod' @($pkg, 0)
$view = Call $db 'OpenView' 'InvokeMethod' @('SELECT ComponentId FROM Component')
[void](Call $view 'Execute' 'InvokeMethod' @())
$out = New-Object System.Collections.ArrayList
while ($rec = Call $view 'Fetch' 'InvokeMethod' @()) {
  $cid = Call $rec 'StringData' 'GetProperty' @(1)
  if (-not $cid) { continue }
  try { $p = [string](Call $i 'ComponentPath' 'GetProperty' @($pc, $cid)) } catch { continue }
  if ($p) { [void]$out.Add($p) }
}
[void](Call $view 'Close' 'InvokeMethod' @())
@($out) | ConvertTo-Json -Compress
`;

const HIVE = { '0': 'HKEY_CLASSES_ROOT', '1': 'HKEY_CURRENT_USER', '2': 'HKEY_LOCAL_MACHINE', '3': 'HKEY_USERS' };

// Turns Windows Installer key paths into removal items: files (grouped into their top folders)
// and registry values.
export function msiItems(keyPaths) {
  const files = [];
  const items = [];
  const folderKeys = []; // components whose key path is a folder (ends with "\")
  for (const raw of keyPaths) {
    if (/^[a-z]:\\.+\\$/i.test(raw)) {
      folderKeys.push(String(raw).replace(/\\$/, ''));
      continue;
    }
    const reg = String(raw).match(/^[02]?([0-3]):\\(.+)$/);
    if (reg) {
      const parts = reg[2].replace(/\\$/, '').split('\\');
      const name = parts.pop();
      const key = `${HIVE[reg[1]]}\\${parts.join('\\')}`;
      if (parts.length && !isProtectedKey(key)) items.push({ kind: 'value', path: key, name, score: 90, reason: 'Listed by its Windows Installer package' });
    } else if (/^[a-z]:\\/i.test(raw)) files.push(String(raw).replace(/\\$/, ''));
  }
  // A folder the package put files in stands for those files, unless it is a shared or system folder.
  const folders = topMost([...new Set([...files.map((f) => path.dirname(f)), ...folderKeys])].filter((d) => !isProtected(d)));
  for (const d of folders) items.push({ kind: 'dir', path: d, score: 100, reason: 'Listed by its Windows Installer package' });
  for (const f of files) if (!folders.some((d) => under(f, d)) && !isProtected(f)) items.push({ kind: 'file', path: f, score: 100, reason: 'Listed by its Windows Installer package' });
  return items;
}

// Strings in an Inno Setup uninstall log (unins000.dat) that name files, folders or registry keys.
const INNO_STRINGS = `
$f = [Console]::In.ReadToEnd().Trim()
if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { '[]'; return }
$b = [IO.File]::ReadAllBytes($f)
$texts = @([Text.Encoding]::GetEncoding(28591).GetString($b), [Text.Encoding]::Unicode.GetString($b), [Text.Encoding]::Unicode.GetString($b, 1, $b.Length - 1))
$found = @{}
foreach ($t in $texts) {
  foreach ($m in [regex]::Matches($t, '[A-Za-z]:\\\\[^\\x00-\\x1f"*?<>|\\u0250-\\uFFFF]{2,259}')) { $found['F' + $m.Value.TrimEnd()] = 1 }
  foreach ($m in [regex]::Matches($t, '(?i)Software\\\\[^\\x00-\\x1f"*?<>|\\u0250-\\uFFFF]{2,200}')) { $found['K' + $m.Value.TrimEnd()] = 1 }
}
@($found.Keys) | ConvertTo-Json -Compress
`;

export function innoItems(strings, existing) {
  const items = [];
  for (const s of strings) {
    if (s.startsWith('F')) {
      const p = s.slice(1).replace(/\\$/, '');
      const kind = existing.get(p.toLowerCase());
      if (kind && !isProtected(p)) items.push({ kind, path: p, score: 95, reason: 'Listed in its Inno Setup uninstall log' });
    } else if (s.startsWith('K')) {
      for (const k of existing.get(`key:${s.slice(1).toLowerCase()}`) || []) {
        if (!isProtectedKey(k)) items.push({ kind: 'key', path: k, score: 85, reason: 'Listed in its Inno Setup uninstall log' });
      }
    }
  }
  // Keep only the top-most of nested folders, files and keys.
  const dirs = topMost(items.filter((i) => i.kind === 'dir').map((i) => i.path));
  const keys = topMost([...new Set(items.filter((i) => i.kind === 'key').map((i) => i.path))]);
  const seen = new Set();
  return items.filter((i) => {
    const keep = i.kind === 'dir' ? dirs.includes(i.path) : i.kind === 'key' ? keys.includes(i.path) : !dirs.some((d) => under(i.path, d));
    const id = `${i.kind}|${i.path}`.toLowerCase();
    if (!keep || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

// Which of the given paths and keys exist: Map(lowercased path -> 'dir'|'file', 'key:<subkey>' -> [full keys]).
async function whichExist(strings) {
  const result = await runPSJson(
    `$in = [Console]::In.ReadToEnd() | ConvertFrom-Json
     $out = foreach ($s in $in) {
       $v = $s.Substring(1)
       if ($s[0] -eq 'F') {
         if (Test-Path -LiteralPath $v -PathType Container) { [pscustomobject]@{ s = $s; kind = 'dir' } }
         elseif (Test-Path -LiteralPath $v -PathType Leaf) { [pscustomobject]@{ s = $s; kind = 'file' } }
       } else {
         foreach ($h in 'HKEY_LOCAL_MACHINE','HKEY_CURRENT_USER') {
           if (Test-Path -LiteralPath "Registry::$h\\$v") { [pscustomobject]@{ s = $s; kind = "$h\\$v" } }
         }
       }
     }
     @($out) | ConvertTo-Json -Compress`,
    { input: JSON.stringify(strings) }
  ).catch(() => []);
  const map = new Map();
  for (const r of result) {
    if (r.s[0] === 'F') map.set(r.s.slice(1).replace(/\\$/, '').toLowerCase(), r.kind);
    else {
      const k = `key:${r.s.slice(1).toLowerCase()}`;
      map.set(k, [...(map.get(k) || []), r.kind]);
    }
  }
  return map;
}

// The files and settings a program's installer recorded, as leftover-scan items.
export async function installerItems(p) {
  const d = detect(p);
  if (d.type === 'msi') {
    const paths = await runPSJson(MSI_PATHS, { input: d.product }).catch(() => []);
    return msiItems(paths);
  }
  if (d.type === 'inno' && d.exe) {
    const log = path.join(path.dirname(d.exe), path.basename(d.exe).replace(/\.exe$/i, '.dat'));
    if (!(await sys.exists(log))) return [];
    const strings = (await runPSJson(INNO_STRINGS, { input: log }).catch(() => [])).filter((s) => !/unins\d{3}\.(exe|dat|msg)$/i.test(s));
    return innoItems(strings, await whichExist(strings));
  }
  return [];
}

// Of items read before an uninstall, the ones still present afterwards.
export async function stillPresent(items) {
  if (!items.length) return [];
  const flags = await runPSJson(
    `$in = [Console]::In.ReadToEnd() | ConvertFrom-Json
     @(foreach ($i in $in) {
       if ($i.kind -eq 'value') { $k = Get-Item -LiteralPath "Registry::$($i.path)" -ErrorAction SilentlyContinue; [bool]($k -and $k.GetValueNames() -contains $i.name) }
       elseif ($i.kind -eq 'key') { Test-Path -LiteralPath "Registry::$($i.path)" }
       elseif ($i.kind -eq 'service') { [bool](Get-Service -Name $i.path -ErrorAction SilentlyContinue) }
       else { Test-Path -LiteralPath $i.path }
     }) | ConvertTo-Json -Compress`,
    { input: JSON.stringify(items.map((i) => ({ kind: i.kind, path: i.path, name: i.name || '' }))) }
  ).catch(() => items.map(() => false));
  return items.filter((_, i) => flags[i] === true);
}

const under = (child, parent) => {
  const c = child.toLowerCase();
  const p = parent.toLowerCase().replace(/\\+$/, '');
  return c === p || c.startsWith(p + '\\');
};
const topMost = (dirs) => dirs.filter((d) => !dirs.some((o) => o !== d && under(d, o)));
