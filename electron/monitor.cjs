// Installation monitoring: snapshot the file system and registry before and after an
// installer runs, then record what was added so it can be removed precisely later.
const fs = require('fs');
const path = require('path');
const { runPS } = require('./shell.cjs');
const { fileRoots, shortcutRoots, isProtected } = require('./paths.cjs');

let storeDir = '';
const setRoot = (dir) => {
  storeDir = dir;
  fs.mkdirSync(path.join(storeDir, 'programs'), { recursive: true });
};
const sessionFile = () => path.join(storeDir, 'session.json');

// Directories to depth 3, files to depth 2 under every well-known root.
function snapshotFiles() {
  const out = [];
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        out.push('D' + full);
        if (depth < 3) walk(full, depth + 1);
      } else if (e.isFile() && depth <= 2) {
        out.push('F' + full);
      }
    }
  };
  for (const root of [...new Set([...fileRoots(), ...shortcutRoots()])]) walk(root, 1);
  return out;
}

const SNAPSHOT_REGISTRY = `
$out = New-Object System.Collections.Generic.List[string]
function Walk([Microsoft.Win32.RegistryKey]$k, [string]$name, [int]$depth) {
  if (-not $k) { return }
  foreach ($s in $k.GetSubKeyNames()) {
    $full = "$name\\$s"
    $out.Add("K$full")
    if ($depth -gt 1) {
      try { $c = $k.OpenSubKey($s) } catch { $c = $null }
      if ($c) { Walk $c $full ($depth - 1); $c.Close() }
    }
  }
}
function Values([Microsoft.Win32.RegistryKey]$k, [string]$name) {
  if (-not $k) { return }
  foreach ($v in $k.GetValueNames()) { $out.Add("V$name|$v") }
}
$LM = [Microsoft.Win32.Registry]::LocalMachine
$CU = [Microsoft.Win32.Registry]::CurrentUser
$targets = @(
  @($LM, 'HKEY_LOCAL_MACHINE', 'SOFTWARE', 2),
  @($LM, 'HKEY_LOCAL_MACHINE', 'SOFTWARE\\WOW6432Node', 2),
  @($CU, 'HKEY_CURRENT_USER', 'Software', 2),
  @($LM, 'HKEY_LOCAL_MACHINE', 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall', 1),
  @($LM, 'HKEY_LOCAL_MACHINE', 'SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall', 1),
  @($CU, 'HKEY_CURRENT_USER', 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', 1),
  @($LM, 'HKEY_LOCAL_MACHINE', 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths', 1),
  @($LM, 'HKEY_LOCAL_MACHINE', 'SYSTEM\\CurrentControlSet\\Services', 1)
)
foreach ($t in $targets) {
  $k = $t[0].OpenSubKey($t[2])
  if ($k) { Walk $k "$($t[1])\\$($t[2])" $t[3]; $k.Close() }
}
foreach ($t in @(@($CU,'HKEY_CURRENT_USER','Software\\Microsoft\\Windows\\CurrentVersion\\Run'), @($LM,'HKEY_LOCAL_MACHINE','SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run'), @($LM,'HKEY_LOCAL_MACHINE','SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Run'))) {
  $k = $t[0].OpenSubKey($t[2]); if ($k) { Values $k "$($t[1])\\$($t[2])"; $k.Close() }
}
[string]::Join([char]10, $out)
`;

async function snapshot() {
  const [files, registry] = await Promise.all([
    Promise.resolve().then(snapshotFiles),
    runPS(SNAPSHOT_REGISTRY).then((s) => s.split(/\r?\n/).filter(Boolean)),
  ]);
  return [...files, ...registry];
}

async function start(installer) {
  const before = await snapshot();
  fs.writeFileSync(sessionFile(), JSON.stringify({ started: new Date().toISOString(), installer, before }));
  return { entries: before.length };
}

const status = () => {
  if (!fs.existsSync(sessionFile())) return null;
  const { started, installer } = JSON.parse(fs.readFileSync(sessionFile(), 'utf8'));
  return { started, installer };
};

const cancel = () => fs.rmSync(sessionFile(), { force: true });

// Keep only top-most added paths: if a folder was added, its children are implied.
function collapse(paths) {
  const sorted = [...paths].sort((a, b) => a.length - b.length);
  const kept = [];
  const keptSet = new Set();
  for (const p of sorted) {
    const lower = p.toLowerCase();
    let parent = lower;
    let implied = false;
    while (parent.includes('\\')) {
      parent = parent.slice(0, parent.lastIndexOf('\\'));
      if (keptSet.has(parent)) {
        implied = true;
        break;
      }
    }
    if (!implied) {
      kept.push(p);
      keptSet.add(lower);
    }
  }
  return kept.sort((a, b) => a.localeCompare(b));
}

async function finish(name) {
  const session = JSON.parse(fs.readFileSync(sessionFile(), 'utf8'));
  const before = new Set(session.before.map((s) => s.toLowerCase()));
  const after = await snapshot();
  const added = after.filter((s) => !before.has(s.toLowerCase()));

  const pick = (prefix) => added.filter((s) => s[0] === prefix).map((s) => s.slice(1));
  const fileItems = collapse([...pick('D'), ...pick('F')])
    .filter((p) => !isProtected(p))
    .map((p) => {
      let kind = 'file';
      try {
        kind = fs.statSync(p).isDirectory() ? 'dir' : 'file';
      } catch {}
      return { kind, path: p, confidence: 'high', reason: 'Created during installation' };
    });
  const keyItems = collapse(pick('K')).map((p) => {
    if (/\\SYSTEM\\CurrentControlSet\\Services\\[^\\]+$/i.test(p)) {
      return { kind: 'service', path: p.split('\\').pop(), confidence: 'high', reason: 'Service created during installation' };
    }
    return { kind: 'key', path: p, confidence: 'high', reason: 'Created during installation' };
  });
  const valueItems = pick('V').map((s) => {
    const [key, valueName] = s.split('|');
    return { kind: 'value', path: key, name: valueName, confidence: 'high', reason: 'Startup entry added' };
  });

  const uninstallKeys = keyItems
    .filter((k) => k.kind === 'key' && /\\CurrentVersion\\Uninstall\\[^\\]+$/i.test(k.path))
    .map((k) => k.path);

  const record = {
    id: `${Date.now()}`,
    name: name || path.basename(session.installer || 'Monitored program'),
    installer: session.installer,
    started: session.started,
    finished: new Date().toISOString(),
    uninstallKeys,
    items: [...keyItems, ...valueItems, ...fileItems],
  };
  fs.writeFileSync(path.join(storeDir, 'programs', `${record.id}.json`), JSON.stringify(record, null, 2));
  cancel();
  return record;
}

function list() {
  const dir = path.join(storeDir, 'programs');
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const remove = (id) => fs.rmSync(path.join(storeDir, 'programs', `${id}.json`), { force: true });

module.exports = { setRoot, start, status, cancel, finish, list, remove, collapse };
