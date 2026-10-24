// "Who owns this?": which installed program a file, folder or registry key belongs to.
// Orphan finder: leftovers of programs that are no longer installed anywhere on the system.
import { sys, env, homeDir } from './sys.js';
import * as path from './winpath.js';
import { runPSJson } from './shell.js';
import { listDesktop, listStore } from './programs.js';
import { nameKey, publisherKey, nameMatches, merge } from './leftovers.js';
import { fileRoots, GENERIC, isProtected, isProtectedKey } from './paths.js';
import * as monitor from './monitor.js';

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const clean = (p) => String(p || '').replace(/^"|"$/g, '').trim().replace(/\\+$/, '');
const under = (child, parent) => {
  const c = child.toLowerCase();
  const p = parent.toLowerCase();
  return c === p || c.startsWith(p + '\\');
};
const longKey = (k) =>
  String(k || '')
    .replace(/^HKLM\\/i, 'HKEY_LOCAL_MACHINE\\')
    .replace(/^HKCU\\/i, 'HKEY_CURRENT_USER\\')
    .replace(/^HKCR\\/i, 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Classes\\');

// Names of vendors and components that belong to Windows or hardware, never to one program.
const SHARED_VENDORS = new Set(
  [
    'microsoft', 'windows', 'intel', 'intel corporation', 'nvidia', 'nvidia corporation', 'amd', 'ati', 'realtek', 'dell', 'hp', 'hewlett-packard', 'lenovo',
    'asus', 'acer', 'msi', 'qualcomm', 'broadcom', 'synaptics', 'elan', 'dolby', 'waves', 'conexant', 'oem', 'drivers', 'driverstore', 'regid.1991-06.com.microsoft',
    'sweepuninstall', 'com.seanshaffer.sweepuninstall', 'node', 'npm', 'npm-cache', 'nuget', 'pip', 'python', 'jedi', 'crashdumps', 'temp', 'connecteddevicesplatform',
    'd3dscache', 'fontcache', 'squirreltemp', 'comms', 'peerdistrepub', 'virtualstore', 'publishers', 'identities', 'ssh', 'gnupg', 'mozilla', 'google',
    'classes', 'clients', 'policies', 'licenses', 'odbc', 'registeredapplications', 'wow6432node', 'partner', 'khronos', 'vulkan', 'openal', 'oracle', 'java', 'javasoft',
  ].map(norm)
);

async function programIndex() {
  const [desktop, store] = await Promise.all([listDesktop().catch(() => []), listStore().catch(() => [])]);
  const programs = [...desktop, ...store];
  return {
    programs,
    names: programs.map((p) => ({ p, key: nameKey(p.name), first: norm(String(p.name).split(/[\s\-_.]+/)[0]), pub: publisherKey(p.publisher), pubFull: norm(p.publisher) })),
    locations: programs.map((p) => ({ p, loc: clean(p.location) })).filter((x) => /^[a-z]:\\.{3,}/i.test(x.loc)),
  };
}

// Programs a path or key may belong to, best first: [{ name, score, why }].
export async function whoOwns(target) {
  const t = clean(target);
  if (!t) return [];
  const isKey = /^(HKEY_|HK(LM|CU|CR|U)\\)/i.test(t);
  const full = isKey ? longKey(t) : t;
  const idx = await programIndex();
  const hits = new Map();
  const add = (name, score, why) => {
    const prev = hits.get(name);
    if (!prev || prev.score < score) hits.set(name, { name, score, why });
  };
  if (!isKey) {
    for (const { p, loc } of idx.locations) if (under(full, loc)) add(p.name, 100, `Inside its install folder (${loc})`);
  } else {
    for (const p of idx.programs) if (p.key && under(full, longKey(p.key))) add(p.name, 100, 'Its uninstall entry');
  }
  for (const rec of await monitor.list().catch(() => [])) {
    const item = rec.items.find((i) => (isKey ? ['key', 'value'].includes(i.kind) : ['dir', 'file'].includes(i.kind)) && under(full, i.path));
    if (item) add(rec.name, 100, 'Recorded when it was installed (Monitored Programs)');
  }
  // Named after a program or its publisher, anywhere along the path (below the user profile, so a
  // user name is never mistaken for a publisher).
  const home = homeDir().replace(/\\+$/, '');
  const rel = !isKey && home && under(full, home) ? full.slice(home.length + 1) : full.split('\\').slice(1).join('\\');
  const segments = rel.split('\\').filter((s) => !GENERIC.has(norm(s)) && !SHARED_VENDORS.has(norm(s)));
  for (const n of idx.names) {
    if (segments.some((s) => nameMatches(s, n.key))) add(n.p.name, 80, 'A folder or key along the way is named after it');
    else if (n.pub && segments.some((s) => norm(s) === n.pub || norm(s) === n.pubFull)) add(n.p.name, 50, `Named after its publisher (${n.p.publisher})`);
  }
  const vendor = full.split('\\').find((s) => SHARED_VENDORS.has(norm(s)));
  const out = [...hits.values()].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, 6);
  if (!out.length && vendor) out.push({ name: `Windows or a hardware vendor (${vendor})`, score: 0, why: 'Shared by Windows or drivers; not a single program' });
  return out;
}

// ---- orphan finder -------------------------------------------------------------------

const RECENT_DAYS = 30;
// Windows' own components in Program Files: named so, or owned by TrustedInstaller.
const WINDOWS_NAMED = /^(windows|microsoft|uninstall information|installshield installation information|package cache|modifiablewindowsapps|windowsapps|reference assemblies|msbuild|internet explorer|common files|wsl)\b/i;
const OWNERS = `
$in = [Console]::In.ReadToEnd() | ConvertFrom-Json
@(foreach ($p in $in) { try { [pscustomobject]@{ path = [string]$p; owner = (Get-Acl -LiteralPath $p).Owner } } catch {} }) | ConvertTo-Json -Compress
`;

const SCAN_REGISTRY = `
$out = foreach ($b in 'HKEY_CURRENT_USER\\Software','HKEY_LOCAL_MACHINE\\SOFTWARE','HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node') {
  foreach ($c in Get-ChildItem -LiteralPath "Registry::$b" -ErrorAction SilentlyContinue) { [pscustomobject]@{ path = $c.Name; name = $c.PSChildName } }
}
$svc = foreach ($s in Get-CimInstance Win32_Service -ErrorAction SilentlyContinue) {
  if (-not $s.PathName) { continue }
  $exe = if ($s.PathName -match '^\\s*"([^"]+)"') { $matches[1] } elseif ($s.PathName -match '^\\s*(\\S+\\.(exe|sys))') { $matches[1] } else { '' }
  if (-not $exe -or $exe -match '^\\W*[a-z]:\\\\Windows\\\\' -or $exe -match '^\\\\SystemRoot\\\\|^System32\\\\') { continue }
  $exe = [Environment]::ExpandEnvironmentVariables($exe)
  if (-not (Test-Path -LiteralPath $exe)) { [pscustomobject]@{ name = $s.Name; display = $s.DisplayName; exe = $exe } }
}
$running = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path } | ForEach-Object { $_.Path })
[pscustomobject]@{ keys = @($out); services = @($svc); running = $running } | ConvertTo-Json -Compress -Depth 4
`;

// Leftovers of programs that are no longer installed. Every finding scores below the auto-select
// line, so nothing is selected until you choose it.
export async function orphans(now = Date.now()) {
  const idx = await programIndex();
  const owned = (name) => {
    const c = norm(name);
    if (!c || GENERIC.has(c) || SHARED_VENDORS.has(c) || c.length < 3) return true;
    // Also a short folder named after a program's first word (\
  };
  const [scan] = await runPSJson(SCAN_REGISTRY).catch(() => [{ keys: [], services: [], running: [] }]);
  const running = (scan?.running || []).map((p) => p.toLowerCase());
  const own = [sys.info.dataDir, env('LOCALAPPDATA') && path.join(env('LOCALAPPDATA'), 'com.seanshaffer.sweepuninstall')].filter(Boolean).map((d) => d.toLowerCase());
  const items = [];

  const programFolders = [env('ProgramFiles'), env('ProgramFiles(x86)')].filter(Boolean).map((r) => r.toLowerCase());
  // LocalLow is left out: it mostly holds games' saves and settings.
  const lowRoot = path.join(homeDir(), 'AppData', 'LocalLow').toLowerCase();
  const roots = [...new Set(fileRoots().map((r) => r.replace(/\\+$/, '')))].filter((r) => r.toLowerCase() !== lowRoot);
  for (const root of roots) {
    for (const d of (await sys.readDir(root).catch(() => [])).filter((e) => e.dir && !e.link)) {
      const full = path.join(root, d.name);
      const lower = full.toLowerCase();
      if (isProtected(full) || owned(d.name) || WINDOWS_NAMED.test(d.name) || own.some((o) => lower.startsWith(o))) continue;
      if (idx.locations.some(({ loc }) => under(loc, full) || under(full, loc))) continue;
      if (running.some((r) => r.startsWith(lower + '\\'))) continue;
      const st = await sys.stat(full).catch(() => null);
      if (!st || now - st.modified < RECENT_DAYS * 86400000) continue; // used recently
      const inProgramFiles = programFolders.some((pf) => lower.startsWith(pf + '\\'));
      const hasPrograms = inProgramFiles && (await sys.walk([full], 2, 2).catch(() => [])).some((e) => /\.exe$/i.test(e));
      const inProfile = lower.startsWith(homeDir().toLowerCase() + '\\');
      items.push({
        kind: 'dir',
        path: full,
        score: hasPrograms ? 30 : inProfile ? 40 : 55,
        reason: hasPrograms
          ? 'No installed program matches it, but it contains programs: it may be a portable or manually installed app'
          : inProfile
            ? 'No installed program matches this folder; it may still hold settings or saved games'
            : 'No installed program matches this folder',
        seen: st.modified,
      });
    }
  }
  // Program Files folders owned by TrustedInstaller are Windows' own.
  const pf = items.filter((i) => programFolders.some((r) => i.path.toLowerCase().startsWith(r + '\\')));
  const acl = pf.length ? await runPSJson(OWNERS, { input: JSON.stringify(pf.map((i) => i.path)) }).catch(() => null) : [];
  const windowsOwned = new Set((acl || []).filter((a) => /TrustedInstaller|^NT AUTHORITY\\SYSTEM$/i.test(a.owner)).map((a) => a.path.toLowerCase()));
  const folders = items.filter((i) => !(acl === null && pf.includes(i)) && !windowsOwned.has(i.path.toLowerCase()));
  items.length = 0;
  items.push(...folders);
  // A registry key is offered only next to a leftover folder of the same name, which keeps
  // shared and system keys out.
  const folderNames = folders.map((f) => nameKey(path.basename(f.path))).filter((n) => n.length >= 3);
  for (const k of scan?.keys || []) {
    if (isProtectedKey(k.path) || owned(k.name)) continue;
    if (!folderNames.some((n) => nameMatches(k.name, n))) continue;
    items.push({ kind: 'key', path: k.path, score: 50, reason: 'Matches a leftover folder, and no installed program' });
  }
  for (const s of scan?.services || []) {
    if (owned(s.name) && owned(s.display)) continue;
    items.push({ kind: 'service', path: s.name, score: 65, reason: `Service whose program no longer exists (${s.exe})` });
  }
  return merge(items);
}
