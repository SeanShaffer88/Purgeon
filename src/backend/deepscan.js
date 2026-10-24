import { sys, env } from './sys.js';
import * as path from './winpath.js';
// Deeper leftover detection: scheduled tasks, firewall rules, Explorer context-menu
// entries and shell extensions, file associations, and app data folders named after the
// program's own executables. Every item carries a 0-100 score of how sure the match is.
import { runPSJson } from './shell.js';
import { GENERIC, isProtected } from './paths.js';

const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Executable names in the install folder (two levels deep), e.g. ["fooeditor", "foohelper"].
async function exeNames(location) {
  const names = new Set();
  const walk = async (dir, depth) => {
    for (const e of await sys.readDir(dir).catch(() => [])) {
      if (e.dir && !e.link && depth < 2) await walk(path.join(dir, e.name), depth + 1);
      else if (e.file && /\.exe$/i.test(e.name) && !/^(unins\d*|uninstall|uninst|setup|update|updater|crashpad_handler|elevate)\.exe$/i.test(e.name)) {
        const base = path.basename(e.name, '.exe');
        if (norm(base).length >= 4 && !GENERIC.has(norm(base))) names.add(base);
      }
    }
  };
  if (location && !isProtected(location)) await walk(location, 0);
  return [...names];
}

// App data and cache folders named exactly after one of the program's executables.
async function exeDataFolders(location, exes) {
  const roots = [env('LOCALAPPDATA'), env('APPDATA'), env('LOCALAPPDATA') && path.join(env('LOCALAPPDATA'), '..', 'LocalLow'), env('TEMP')].filter(Boolean);
  const wanted = new Set(exes.map(norm));
  const items = [];
  for (const root of roots) {
    for (const e of await sys.readDir(root).catch(() => [])) {
      const full = path.join(root, e.name);
      if (e.dir && !e.link && wanted.has(norm(e.name)) && !isProtected(full) && !full.toLowerCase().startsWith((location || '?').toLowerCase())) {
        items.push({ kind: 'dir', path: full, score: 70, reason: `Data folder named after ${e.name}.exe` });
      }
    }
  }
  return items;
}

const SCAN_DEEP = `
$in = [Console]::In.ReadToEnd() | ConvertFrom-Json
$generic = $in.generic
function N($s) { ([string]$s).ToLower() -replace '[^a-z0-9]','' }
function M($cand, $key) {
  $c = N $cand
  if (-not $c -or -not $key -or $generic -contains $c) { return $false }
  if ($c -eq $key) { return $true }
  if ($c.Length -ge 5 -and $key.StartsWith($c)) { return $true }
  if ($key.Length -ge 5 -and $c.StartsWith($key)) { return $true }
  return $false
}
$loc = if ($in.location) { $in.location.TrimEnd('\\').ToLower() + '\\' } else { $null }
function InLoc($text) { $loc -and $text -and ([string]$text).ToLower().Replace('"','').Contains($loc) }
$res = New-Object System.Collections.ArrayList
function Add($kind, $path, $score, $reason, $name) { [void]$res.Add([pscustomobject]@{ kind=$kind; path=$path; name=$name; score=$score; reason=$reason }) }

# Scheduled tasks outside \\Microsoft\\
foreach ($t in Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskPath -notlike '\\Microsoft\\*' }) {
  $full = "$($t.TaskPath)$($t.TaskName)"
  $byPath = @($t.Actions | Where-Object { (InLoc $_.Execute) -or (InLoc $_.Arguments) -or (InLoc $_.WorkingDirectory) }).Count -gt 0
  if ($byPath) { Add 'task' $full 95 'Scheduled task runs a file from the install folder' $t.TaskName }
  elseif (M $t.TaskName $in.nameKey) { Add 'task' $full 60 'Scheduled task named after program' $t.TaskName }
}

# Firewall rules for programs in the install folder
if ($loc) {
  foreach ($f in Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue | Where-Object { InLoc $_.Program }) {
    $rule = $f | Get-NetFirewallRule -ErrorAction SilentlyContinue
    if ($rule) { Add 'firewall' $rule.Name 95 "Firewall rule for $([IO.Path]::GetFileName($f.Program))" $rule.DisplayName }
  }
}

# Explorer context-menu verbs, shell extensions, file associations
foreach ($classes in 'HKEY_CURRENT_USER\\Software\\Classes','HKEY_LOCAL_MACHINE\\SOFTWARE\\Classes') {
  foreach ($base in '*','Directory','Directory\\Background','Drive','Folder','AllFilesystemObjects') {
    foreach ($verb in Get-ChildItem -LiteralPath "Registry::$classes\\$base\\shell" -ErrorAction SilentlyContinue) {
      $cmd = (Get-ItemProperty -LiteralPath "Registry::$($verb.Name)\\command" -ErrorAction SilentlyContinue).'(default)'
      if (InLoc $cmd) { Add 'key' $verb.Name 95 'Context-menu entry runs the program' $null }
      elseif (M $verb.PSChildName $in.nameKey) { Add 'key' $verb.Name 55 'Context-menu entry named after program' $null }
    }
    foreach ($h in Get-ChildItem -LiteralPath "Registry::$classes\\$base\\shellex\\ContextMenuHandlers" -ErrorAction SilentlyContinue) {
      $clsid = [string](Get-ItemProperty -LiteralPath $h.PSPath -ErrorAction SilentlyContinue).'(default)'
      if ($clsid -notmatch '^\\{') { $clsid = $h.PSChildName }
      $dll = $null
      foreach ($c in 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Classes','HKEY_CURRENT_USER\\Software\\Classes') {
        $d = (Get-ItemProperty -LiteralPath "Registry::$c\\CLSID\\$clsid\\InprocServer32" -ErrorAction SilentlyContinue).'(default)'
        if (InLoc $d) { $dll = $d; Add 'key' "$c\\CLSID\\$clsid" 90 "Shell extension $([IO.Path]::GetFileName($d))" $null }
      }
      if ($dll) { Add 'key' $h.Name 95 'Context-menu handler registration' $null }
      elseif (M $h.PSChildName $in.nameKey) { Add 'key' $h.Name 50 'Context-menu handler named after program' $null }
    }
  }
  foreach ($exe in $in.exes) {
    $k = "$classes\\Applications\\$exe.exe"
    if (Test-Path -LiteralPath "Registry::$k") { Add 'key' $k 80 "Open-with registration for $exe.exe" $null }
  }
  $root = Get-Item -LiteralPath "Registry::$classes" -ErrorAction SilentlyContinue
  if ($root) {
    foreach ($progid in $root.GetSubKeyNames() | Where-Object { -not $_.StartsWith('.') -and $_ -ne '*' -and (M ($_ -split '\\.')[0] $in.nameKey) }) {
      $cmd = (Get-ItemProperty -LiteralPath "Registry::$classes\\$progid\\shell\\open\\command" -ErrorAction SilentlyContinue).'(default)'
      if (InLoc $cmd) { Add 'key' "$classes\\$progid" 90 'File type opened by the program' $null }
    }
  }
}
@($res) | ConvertTo-Json -Compress -Depth 3
`;

async function scanDeep(program, { nameKey, location }) {
  const loc = location && !isProtected(location) ? location : '';
  const exes = await exeNames(loc);
  const input = JSON.stringify({ nameKey, location: loc, exes, generic: [...GENERIC] });
  const [registry, folders] = await Promise.all([runPSJson(SCAN_DEEP, { input }).catch(() => []), exeDataFolders(loc, exes)]);
  return [...registry, ...folders];
}

export { scanDeep, exeNames, exeDataFolders };
