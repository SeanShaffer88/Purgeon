// Heuristic analysis of what a program left on disk and in the registry.
// Items: { kind: 'dir'|'file'|'key'|'value'|'service', path, name?, confidence: 'high'|'low', reason }
const fs = require('fs');
const path = require('path');
const { runPSJson, psq } = require('./shell.cjs');
const { fileRoots, shortcutRoots, GENERIC, isProtected } = require('./paths.cjs');
const { scanDeep } = require('./deepscan.cjs');

const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// "Foo Editor 3.2.1 (x64)" -> "fooeditor"
function nameKey(name) {
  return norm(
    (name || '')
      .replace(/\(.*?\)/g, ' ')
      .replace(/\bv?\d+(\.\d+)+\S*/gi, ' ')
      .replace(/\b(x64|x86|64-bit|32-bit|64 bit|32 bit|version|edition)\b/gi, ' ')
  );
}

function publisherKey(pub) {
  return norm((pub || '').replace(/\b(inc|llc|ltd|gmbh|corp|corporation|co|limited|s\.?a|ag|software|technologies)\b\.?/gi, ' '));
}

// Does a folder/key name plausibly belong to the program?
function nameMatches(candidate, key) {
  const c = norm(candidate);
  if (!c || !key || GENERIC.has(c)) return false;
  if (c === key) return true;
  if (c.length >= 5 && key.startsWith(c)) return true;
  if (key.length >= 5 && c.startsWith(key)) return true;
  return false;
}

const listDirs = (dir) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.isSymbolicLink());
  } catch {
    return [];
  }
};

function* walkFiles(dir, depth = 0) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory() && !e.isSymbolicLink() && depth < 4) yield* walkFiles(full, depth + 1);
    else if (e.isFile()) yield full;
  }
}

const exists = (p) => {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
};

const under = (child, parent) => {
  const c = path.resolve(child).toLowerCase();
  const p = path.resolve(parent).toLowerCase().replace(/[\\/]+$/, '');
  return c === p || c.startsWith(p + '\\');
};

function scanFiles(program, readShortcutLink) {
  const items = [];
  // A folder replaces the items inside it, except a `container` guess (a publisher folder):
  // that one is offered alongside its children so an unticked guess never hides a ticked match.
  const add = (kind, p, confidence, reason, { container = false } = {}) => {
    if (isProtected(p) || items.some((i) => !i.container && under(p, i.path))) return;
    if (!container) for (let i = items.length - 1; i >= 0; i--) if (under(items[i].path, p)) items.splice(i, 1);
    items.push({ kind, path: p, confidence, reason, ...(container && { container }) });
  };

  const nk = nameKey(program.name);
  const pk = publisherKey(program.publisher);
  // A folder belongs to the publisher only when named exactly after it, so "Google Play Games"
  // is never taken for Google's folder when removing Chrome.
  const isPublisher = (dirName) => {
    const c = norm(dirName);
    return !!pk && !GENERIC.has(c) && (c === pk || c === norm(program.publisher));
  };
  const location = (program.location || '').replace(/^"|"$/g, '').trim();

  if (location && exists(location) && !isProtected(location)) add('dir', location, 'high', 'Install location');

  for (const root of fileRoots()) {
    for (const d of listDirs(root)) {
      const full = path.join(root, d.name);
      if (nameMatches(d.name, nk)) {
        add('dir', full, 'high', `Folder named after program`);
      } else if (isPublisher(d.name)) {
        const children = listDirs(full);
        const hit = children.filter((c) => nameMatches(c.name, nk));
        for (const c of hit) add('dir', path.join(full, c.name), 'high', `Folder under publisher "${d.name}"`);
        if (hit.length && hit.length === children.length) {
          add('dir', full, 'low', 'Publisher folder (would be empty)', { container: true });
        }
      }
    }
  }

  for (const root of shortcutRoots()) {
    for (const f of walkFiles(root)) {
      if (!/\.(lnk|url)$/i.test(f)) continue;
      let target = '';
      if (f.toLowerCase().endsWith('.lnk')) {
        try {
          target = readShortcutLink(f).target || '';
        } catch {}
      }
      if (location && target && under(target, location)) add('file', f, 'high', 'Shortcut to install folder');
      else if (nameMatches(path.basename(f, path.extname(f)), nk)) add('file', f, 'low', 'Shortcut named after program');
    }
    for (const d of listDirs(root)) {
      if (nameMatches(d.name, nk)) add('dir', path.join(root, d.name), 'high', 'Start Menu folder');
      else if (isPublisher(d.name)) add('dir', path.join(root, d.name), 'low', 'Start Menu publisher folder', { container: true });
    }
  }
  return items;
}

const SCAN_REGISTRY = `
$in = [Console]::In.ReadToEnd() | ConvertFrom-Json
$generic = $in.generic
function N($s) { ($s.ToLower() -replace '[^a-z0-9]','') }
function M($cand, $key) {
  $c = N $cand
  if (-not $c -or -not $key -or $generic -contains $c) { return $false }
  if ($c -eq $key) { return $true }
  if ($c.Length -ge 5 -and $key.StartsWith($c)) { return $true }
  if ($key.Length -ge 5 -and $c.StartsWith($key)) { return $true }
  return $false
}
$res = New-Object System.Collections.ArrayList
function Add($kind, $path, $conf, $reason, $name) { [void]$res.Add([pscustomobject]@{ kind=$kind; path=$path; name=$name; confidence=$conf; reason=$reason }) }

if ($in.uninstallKey -and (Test-Path -LiteralPath "Registry::$($in.uninstallKey)")) { Add 'key' $in.uninstallKey 'high' 'Uninstall entry' $null }

foreach ($b in 'HKEY_CURRENT_USER\\Software','HKEY_LOCAL_MACHINE\\SOFTWARE','HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node') {
  foreach ($c in Get-ChildItem -LiteralPath "Registry::$b" -ErrorAction SilentlyContinue) {
    if (M $c.PSChildName $in.nameKey) { Add 'key' $c.Name 'high' 'Software key named after program' $null; continue }
    $pn = N $c.PSChildName
    if ($in.publisherKey -and $generic -notcontains $pn -and ($pn -eq $in.publisherKey -or $pn -eq $in.publisherFull)) {
      $kids = @(Get-ChildItem -LiteralPath $c.PSPath -ErrorAction SilentlyContinue)
      $hits = @($kids | Where-Object { M $_.PSChildName $in.nameKey })
      foreach ($h in $hits) { Add 'key' $h.Name 'high' "Key under publisher $($c.PSChildName)" $null }
      if ($hits.Count -gt 0 -and $hits.Count -eq $kids.Count) { Add 'key' $c.Name 'low' 'Publisher key (would be empty)' $null }
    }
  }
}

$loc = $in.location
if ($loc) {
  $loc = $loc.TrimEnd('\\').ToLower()
  foreach ($ap in 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths','HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths') {
    foreach ($k in Get-ChildItem -LiteralPath "Registry::$ap" -ErrorAction SilentlyContinue) {
      $d = [string](Get-ItemProperty -LiteralPath $k.PSPath -ErrorAction SilentlyContinue).'(default)'
      if ($d -and $d.Trim('"').ToLower().StartsWith($loc + '\\')) { Add 'key' $k.Name 'high' 'App Paths registration' $null }
    }
  }
  foreach ($run in 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run','HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run','HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Run') {
    $k = Get-Item -LiteralPath "Registry::$run" -ErrorAction SilentlyContinue
    if (-not $k) { continue }
    foreach ($v in $k.GetValueNames()) {
      $d = [string]$k.GetValue($v)
      if ($d.ToLower().Contains($loc + '\\')) { Add 'value' $run 'high' 'Runs at startup' $v }
    }
  }
  foreach ($s in Get-CimInstance Win32_Service -ErrorAction SilentlyContinue) {
    if ($s.PathName -and $s.PathName.ToLower().Contains($loc + '\\')) { Add 'service' $s.Name 'high' "Service: $($s.DisplayName)" $null }
  }
}
@($res) | ConvertTo-Json -Compress -Depth 3
`;

async function scanRegistry(program) {
  const location = (program.location || '').replace(/^"|"$/g, '').trim();
  const input = JSON.stringify({
    nameKey: nameKey(program.name),
    publisherKey: publisherKey(program.publisher),
    publisherFull: norm(program.publisher),
    uninstallKey: program.key || '',
    location: location && !isProtected(location) ? location : '',
    generic: [...GENERIC],
  });
  const items = await runPSJson(SCAN_REGISTRY, { input });
  const seen = new Set();
  return items.filter((i) => {
    const id = `${i.kind}|${i.path}|${i.name || ''}`.toLowerCase();
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

// How sure each kind of match is, 0-100. Items scoring 70 or more start ticked.
const SCORES = [
  [/^Uninstall entry/, 100],
  [/^Install location/, 100],
  [/^App Paths/, 95],
  [/^Runs at startup/, 95],
  [/^Service:/, 95],
  [/^Shortcut to install folder/, 95],
  [/^Folder under publisher|^Key under publisher/, 85],
  [/^Folder named after program/, 85],
  [/^Software key named after program/, 80],
  [/^Start Menu folder/, 80],
  [/^Shortcut named after program/, 45],
  [/^Publisher (folder|key)|^Start Menu publisher folder/, 35],
];
const AUTO_TICK = 70;

function scoreFor(item) {
  if (typeof item.score === 'number') return item.score;
  const hit = SCORES.find(([re]) => re.test(item.reason || ''));
  return hit ? hit[1] : item.confidence === 'high' ? 80 : 40;
}

// Merges findings: one entry per item, keeping the strongest score and reason.
function merge(items) {
  const byId = new Map();
  for (const raw of items) {
    const score = scoreFor(raw);
    const item = { ...raw, score, confidence: score >= AUTO_TICK ? 'high' : 'low' };
    const id = `${item.kind}|${item.path}|${item.name || ''}`.toLowerCase();
    const prev = byId.get(id);
    if (!prev || prev.score < score) byId.set(id, { ...item, ...(prev?.container && { container: true }) });
  }
  return [...byId.values()];
}

async function scan(program, readShortcutLink) {
  const location = (program.location || '').replace(/^"|"$/g, '').trim();
  const [files, registry, deep] = await Promise.all([
    Promise.resolve().then(() => scanFiles(program, readShortcutLink)),
    scanRegistry(program),
    scanDeep(program, { nameKey: nameKey(program.name), location }),
  ]);
  return merge([...registry, ...deep, ...files]);
}

// Processes running from inside the install folder, so they can be closed before deletion.
async function processesIn(location) {
  if (!location || isProtected(location)) return [];
  return runPSJson(
    `@(Get-Process | Where-Object { $_.Path -and $_.Path.ToLower().StartsWith(${psq(location.toLowerCase().replace(/\\+$/, '') + '\\')}) } | Select-Object Id, ProcessName, Path) | ConvertTo-Json -Compress`
  );
}

module.exports = { scan, processesIn, nameKey, under, exists, nameMatches, publisherKey, scanFiles, scoreFor, merge, AUTO_TICK };
