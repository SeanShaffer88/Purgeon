// Junk files: temporary files, crash dumps, error reports and caches that Windows and programs
// recreate when needed. Only the contents of these known folders are cleaned, never the folders
// themselves, and only items left untouched for a while. Everything goes to the Recycle Bin
// (through backups.removeItems), so a cleanup can be undone. The registry is never touched.
import { sys, env } from './sys.js';
import * as path from './winpath.js';
import { runPS, runPSJson, reg } from './shell.js';
import * as programs from './programs.js';

const DAY = 24 * 3600 * 1000;

const local = (...p) => env('LOCALAPPDATA') && path.join(env('LOCALAPPDATA'), ...p);
const win = (...p) => env('SystemRoot') && path.join(env('SystemRoot'), ...p);
const progData = (...p) => env('ProgramData') && path.join(env('ProgramData'), ...p);

export const CATEGORIES = [
  { id: 'usertemp', label: 'Temporary files', detail: 'Your Temp folder. Items used in the last day are kept.', roots: () => [env('TEMP')], minAge: DAY },
  { id: 'wintemp', label: 'Windows temporary files', detail: 'The Windows Temp folder. Items used in the last day are kept.', roots: () => [win('Temp')], minAge: DAY, admin: true },
  { id: 'dumps', label: 'Crash dumps', detail: 'Memory dumps written when programs or Windows crashed.', roots: () => [local('CrashDumps'), win('Minidump')], files: () => [win('MEMORY.DMP')] },
  {
    id: 'wer',
    label: 'Windows error reports',
    detail: 'Problem reports already sent or queued for Microsoft.',
    roots: () => [progData('Microsoft', 'Windows', 'WER', 'ReportArchive'), progData('Microsoft', 'Windows', 'WER', 'ReportQueue'), local('Microsoft', 'Windows', 'WER', 'ReportArchive'), local('Microsoft', 'Windows', 'WER', 'ReportQueue')],
  },
  { id: 'thumbs', label: 'Thumbnail cache', detail: 'Explorer rebuilds thumbnails when needed. Files in use are skipped.', roots: () => [local('Microsoft', 'Windows', 'Explorer')], match: /^thumbcache_.*\.db$/i },
  { id: 'shaders', label: 'DirectX shader cache', detail: 'Compiled graphics shaders; games and apps rebuild them.', roots: () => [local('D3DSCache'), local('NVIDIA', 'DXCache'), local('AMD', 'DxCache')] },
  { id: 'update', label: 'Windows Update downloads', detail: 'Update files already downloaded. Windows downloads them again if still needed.', roots: () => [win('SoftwareDistribution', 'Download')], minAge: 3 * DAY, admin: true },
  {
    id: 'delivery',
    label: 'Delivery Optimization cache',
    detail: 'Update pieces kept to share with other PCs.',
    roots: () => [win('ServiceProfiles', 'NetworkService', 'AppData', 'Local', 'Microsoft', 'Windows', 'DeliveryOptimization', 'Cache')],
    admin: true,
  },
  // Privacy traces: not junk as such, so they start unselected.
  { id: 'recent', label: 'Recent files list', detail: 'Shortcuts to files you opened recently. The files themselves are not touched.', roots: () => [env('APPDATA') && path.join(env('APPDATA'), 'Microsoft', 'Windows', 'Recent')], match: /\.lnk$/i, privacy: true },
  {
    id: 'jumplists',
    label: 'Jump lists',
    detail: 'Recent and pinned items shown when you right-click taskbar icons.',
    roots: () => [env('APPDATA') && path.join(env('APPDATA'), 'Microsoft', 'Windows', 'Recent', 'AutomaticDestinations'), env('APPDATA') && path.join(env('APPDATA'), 'Microsoft', 'Windows', 'Recent', 'CustomDestinations')],
    match: /-ms$|Destinations-ms$|\.(automatic|custom)Destinations-ms$/i,
    privacy: true,
  },
  { id: 'iconcache', label: 'Icon cache', detail: 'Explorer rebuilds program and file icons when needed. Files in use are skipped.', roots: () => [local('Microsoft', 'Windows', 'Explorer')], match: /^iconcache_.*\.db$/i, privacy: true },
  {
    id: 'appdata',
    label: 'Leftover app data folders',
    detail: 'Data folders of Microsoft Store apps that are no longer installed.',
    roots: () => [local('Packages')],
    orphanPackages: true,
  },
  // Browser caches — safe to clean, browsers rebuild them.
  { id: 'chrome-cache',
    label: 'Google Chrome cache',
    detail: 'Chromium cache, code cache and GPU cache. Sites load again on next visit.',
    roots: () => [
      local('Google', 'Chrome', 'User Data', 'Default', 'Cache'),
      local('Google', 'Chrome', 'User Data', 'Default', 'Code Cache'),
      local('Google', 'Chrome', 'User Data', 'Default', 'GPUCache'),
      local('Google', 'Chrome SxS', 'User Data', 'Default', 'Cache'),
      local('Google', 'Chrome SxS', 'User Data', 'Default', 'Code Cache'),
      local('Google', 'Chrome SxS', 'User Data', 'Default', 'GPUCache'),
    ],
    minAge: DAY,
  },
  { id: 'edge-cache',
    label: 'Microsoft Edge cache',
    detail: 'Chromium cache, code cache and GPU cache. Sites load again on next visit.',
    roots: () => [
      local('Microsoft', 'Edge', 'User Data', 'Default', 'Cache'),
      local('Microsoft', 'Edge', 'User Data', 'Default', 'Code Cache'),
      local('Microsoft', 'Edge', 'User Data', 'Default', 'GPUCache'),
      local('Microsoft', 'Edge SxS', 'User Data', 'Default', 'Cache'),
      local('Microsoft', 'Edge SxS', 'User Data', 'Default', 'Code Cache'),
      local('Microsoft', 'Edge SxS', 'User Data', 'Default', 'GPUCache'),
    ],
    minAge: DAY,
  },
  { id: 'firefox-cache',
    label: 'Mozilla Firefox cache',
    detail: 'Firefox cache2 and startup cache. Pages re-fetch assets on next visit.',
    roots: () => [local('Mozilla', 'Firefox', 'Profiles')],
    match: /^(cache2|startupCache)$/i,
    minAge: DAY,
  },
  // Browser cookies, history and site data — privacy traces, never selected by default.
  { id: 'chrome-cookies',
    label: 'Chrome cookies and history',
    detail: 'Cookies, browsing history, visited links and top sites. Signs you out of sites.',
    roots: () => [
      local('Google', 'Chrome', 'User Data', 'Default'),
      local('Google', 'Chrome SxS', 'User Data', 'Default'),
    ],
    match: /^(Cookies|History|Visited Links|Top Sites|Login Data|Web Data)$/i,
    privacy: true,
  },
  { id: 'edge-cookies',
    label: 'Edge cookies and history',
    detail: 'Cookies, browsing history, visited links and top sites. Signs you out of sites.',
    roots: () => [
      local('Microsoft', 'Edge', 'User Data', 'Default'),
      local('Microsoft', 'Edge SxS', 'User Data', 'Default'),
    ],
    match: /^(Cookies|History|Visited Links|Top Sites|Login Data|Web Data)$/i,
    privacy: true,
  },
  { id: 'firefox-cookies',
    label: 'Firefox cookies and history',
    detail: 'Cookies, browsing history, favicons and site data. Signs you out of sites.',
    roots: () => [local('Mozilla', 'Firefox', 'Profiles')],
    match: /^(cookies\.sqlite|places\.sqlite|favicons\.sqlite|siteSecurityService\.txt)$/i,
    privacy: true,
  },
  // Large folders in AppData and ProgramData that may belong to programs no longer installed.
  // Offered unselected; the user reviews each one before cleaning.
  {
    id: 'orphan-large',
    label: 'Large orphaned folders',
    detail: 'Folders larger than 100 MB in AppData and ProgramData whose name does not match an installed program. Might be leftovers from uninstalled programs; review before removing.',
    roots: () => [local(''), progData('')],  // LOCALAPPDATA and ProgramData roots
    minBytes: 100 * 1024 * 1024,
    orphan: true,
  },
];

// ---- Windows' own clean-up tools -------------------------------------------------------
// These are done by Windows itself (DISM, Disk Cleanup, Volume Shadow Copy) and cannot be undone
// through the Recycle Bin, so they are never selected by default and need administrator rights.

const drive = () => (env('SystemDrive') || 'C:').replace(/\\+$/, '');
const freeBytes = async () => Number((await runPS(`(Get-PSDrive -Name ${drive().slice(0, 1)}).Free`).catch(() => '0')).trim()) || 0;

// Runs one Disk Cleanup handler: sets its StateFlags for a private set number, runs cleanmgr with
// that set, then removes the flag again so no setting is left behind.
async function diskCleanup(handler) {
  const key = `HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\VolumeCaches\\${handler}`;
  if (!(await reg(['query', key])).ok) return { ok: false, detail: 'This Disk Cleanup option is not available on this PC' };
  const set = await reg(['add', key, '/v', 'StateFlags0177', '/t', 'REG_DWORD', '/d', '2', '/f']);
  if (!set.ok) return { ok: false, detail: set.stderr.trim() || 'Needs administrator rights' };
  try {
    const r = await sys.exec('cleanmgr.exe', ['/sagerun:177']);
    return { ok: r.ok, detail: r.ok ? 'Done by Windows Disk Cleanup' : `Disk Cleanup exited with code ${r.code}` };
  } finally {
    await reg(['delete', key, '/v', 'StateFlags0177', '/f']);
  }
}

const folderBytes = async (p) => ((await sys.exists(p)) ? (await sys.folderSize(p, 2000000, 20000)).bytes : 0);

export const SYSTEM_CATEGORIES = [
  {
    id: 'winsxs',
    label: 'Outdated WinSxS libraries',
    detail: "Superseded Windows components kept after updates. Removed with Windows' DISM tool; updates installed so far can no longer be uninstalled.",
    measure: async () => ({ present: true, bytes: null, note: 'Size is reported after cleaning' }),
    clean: async () => {
      const r = await sys.exec('Dism.exe', ['/Online', '/Cleanup-Image', '/StartComponentCleanup']);
      return { ok: r.ok, detail: r.ok ? 'Done by Windows DISM' : (String(r.stdout || r.stderr).trim().split(/\r?\n/).pop() || `DISM exited with code ${r.code}`) };
    },
  },
  {
    id: 'windowsold',
    label: 'Previous Windows installation',
    detail: 'Windows.old, kept after a Windows upgrade. Once removed, you can no longer go back to the previous version of Windows.',
    measure: async () => {
      const p = `${drive()}\\Windows.old`;
      return (await sys.exists(p)) ? { present: true, bytes: await folderBytes(p) } : { present: false };
    },
    clean: () => diskCleanup('Previous Installations'),
  },
  {
    id: 'updatecleanup',
    label: 'Windows Update clean-up',
    detail: 'Older versions of updates that newer ones replaced. Removed by Windows Disk Cleanup.',
    measure: async () => ({ present: true, bytes: null, note: 'Size is reported after cleaning' }),
    clean: () => diskCleanup('Update Cleanup'),
  },
  {
    id: 'retaildemo',
    label: 'Windows demo content',
    detail: 'Store demo-mode content shipped with some PCs.',
    measure: async () => {
      const p = env('ProgramData') && path.join(env('ProgramData'), 'Microsoft', 'Windows', 'RetailDemo');
      const bytes = p ? await folderBytes(p) : 0;
      return bytes ? { present: true, bytes } : { present: false };
    },
    clean: () => diskCleanup('RetailDemo Offline Content'),
  },
  {
    id: 'restorepoints',
    label: 'Older system restore points',
    detail: 'Every restore point except the newest one. The newest is kept so you can still go back to it.',
    measure: async () => {
      const [s] = await runPSJson(
        `$c = @(Get-CimInstance Win32_ShadowCopy -ErrorAction Stop | Where-Object { $_.ClientAccessible })
         $u = (Get-CimInstance Win32_ShadowStorage -ErrorAction SilentlyContinue | Measure-Object -Property UsedSpace -Sum).Sum
         [pscustomobject]@{ count = $c.Count; used = [int64]$u } | ConvertTo-Json -Compress`
      ).catch(() => [null]);
      if (!s || s.count < 2) return { present: false };
      return { present: true, bytes: Math.round((s.used * (s.count - 1)) / s.count), note: `${s.count - 1} of ${s.count} restore points` };
    },
    clean: async () => {
      const out = await runPS(
        `$c = @(Get-CimInstance Win32_ShadowCopy -ErrorAction Stop | Where-Object { $_.ClientAccessible } | Sort-Object InstallDate)
         if ($c.Count -lt 2) { 'NONE'; return }
         $n = 0
         foreach ($s in $c[0..($c.Count - 2)]) { & vssadmin.exe delete shadows "/shadow=$($s.ID)" /quiet | Out-Null; if ($LASTEXITCODE -eq 0) { $n++ } }
         "$n of $($c.Count - 1)"`
      ).catch((e) => `ERR ${e.message}`);
      return /^ERR/.test(out) ? { ok: false, detail: out.slice(4).trim() } : { ok: true, detail: out.trim() === 'NONE' ? 'Nothing to remove' : `Removed ${out.trim()} older restore points; the newest was kept` };
    },
  },
];

// Measures every Windows clean-up option: [{ id, label, detail, system: true, admin: true, present, bytes, note }].
export async function scanSystem() {
  return Promise.all(
    SYSTEM_CATEGORIES.map(async (c) => {
      const m = await c.measure().catch(() => ({ present: false }));
      return { id: c.id, label: c.label, detail: c.detail, system: true, admin: true, items: [], present: !!m.present, bytes: m.bytes ?? null, note: m.note || '' };
    })
  );
}

// Runs the chosen Windows clean-up options one by one: [{ id, label, ok, detail, freed }].
export async function cleanSystem(ids) {
  const results = [];
  for (const c of SYSTEM_CATEGORIES.filter((x) => ids.includes(x.id))) {
    const before = await freeBytes();
    const r = await c.clean().catch((e) => ({ ok: false, detail: String(e?.message || e) }));
    const freed = Math.max(0, (await freeBytes()) - before);
    results.push({ id: c.id, label: c.label, ok: r.ok, detail: r.detail, freed });
  }
  return results;
}

// Package family names installed for this user, to tell leftover app data from live app data.
export async function installedFamilies() {
  const out = await runPS('@(Get-AppxPackage -ErrorAction SilentlyContinue | ForEach-Object { $_.PackageFamilyName }) -join "`n"');
  const set = new Set(out.split(/\r?\n/).map((s) => s.trim().toLowerCase()).filter(Boolean));
  if (!set.size) throw new Error('Could not read the installed apps');
  return set;
}

const allRoots = () =>
  CATEGORIES.flatMap((c) => c.roots())
    .filter(Boolean)
    .map((r) => path.resolve(r).toLowerCase());
const allFiles = () =>
  CATEGORIES.flatMap((c) => (c.files ? c.files() : []))
    .filter(Boolean)
    .map((r) => path.resolve(r).toLowerCase());

// Whether a path may be cleaned as junk: strictly inside one of the junk folders, or one of the known junk files.
export function isJunkPath(p) {
  if (!p || !/^[a-z]:\\/i.test(p) || /(^|\\)\.\.(\\|$)/.test(p)) return false;
  const n = path.resolve(p).toLowerCase().replace(/\\+$/, '');
  return allFiles().includes(n) || allRoots().some((r) => n.startsWith(r + '\\'));
}

// Lists what each category would clean: [{ id, label, detail, admin, bytes, items: [{ path, dir, bytes }] }].
export async function scan(now = Date.now()) {
  const own = [sys.info.dataDir].filter(Boolean).map((d) => path.resolve(d).toLowerCase());
  // App data is offered only for apps that are not installed; if that can't be read, none is offered.
  const families = await installedFamilies().catch(() => null);
  // Desktop program names, to tell orphaned folders from live program folders.
  const desktop = await programs.listDesktop().catch(() => []);
  const programNames = new Set(desktop.map((p) => (p.name || '').toLowerCase()));
  return Promise.all(
    CATEGORIES.map(async (c) => {
      const items = [];
      if (c.orphanPackages && !families) return { id: c.id, label: c.label, detail: c.detail, admin: !!c.admin, bytes: 0, items };
      for (const root of [...new Set(c.roots().filter(Boolean))]) {
        for (const e of await sys.listJunk(root, 8000).catch(() => [])) {
          if (c.match && !c.match.test(path.basename(e.path))) continue;
          if (c.orphanPackages && (!e.dir || families.has(path.basename(e.path).toLowerCase()) || !/_[a-z0-9]{13}$/i.test(path.basename(e.path)))) continue;
          if (c.minAge && now - e.newest < c.minAge) continue;
          if (c.minBytes && e.bytes < c.minBytes) continue;
          if (c.orphan && e.dir && programNames.has(path.basename(e.path).toLowerCase())) continue;
          if (own.some((o) => e.path.toLowerCase().startsWith(o))) continue;
          items.push({ path: e.path, dir: e.dir, bytes: e.bytes });
        }
      }
      for (const f of (c.files ? c.files() : []).filter(Boolean)) {
        const s = await sys.stat(f).catch(() => null);
        if (s && !s.dir) items.push({ path: f, dir: false, bytes: s.size });
      }
      return { id: c.id, label: c.label, detail: c.detail, admin: !!c.admin, privacy: !!c.privacy, bytes: items.reduce((n, i) => n + i.bytes, 0), items };
    })
  );
}

// Cleanup items for backups.removeItems from the chosen categories of a scan.
export const cleanupItems = (categories) =>
  categories.flatMap((c) => c.items.map((i) => ({ kind: 'junk', path: i.path, dir: i.dir, bytes: i.bytes, confidence: 'high', reason: c.label })));
