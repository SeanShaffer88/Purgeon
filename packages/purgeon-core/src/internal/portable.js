// Portable apps: programs that run from a folder without an installer, so Windows doesn't list
// them. Registering one adds a per-user uninstall entry (marked as Purgeon's), so it gets
// an icon, a group, leftover scans and a clean removal like any installed program.
import { sys, env, homeDir } from './sys.js';
import * as path from './winpath.js';
import { reg, runPSJson } from './shell.js';
import { listDesktop } from './programs.js';
import { isProtected } from './paths.js';
import * as winget from './winget.js';

const UNINSTALL = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall';
const PREFIX = 'SweepPortable_';
const HELPER = /(^|\\)(unins\d*|uninst\w*|setup|update\w*|helper|crash\w*|elevate\w*|vc_redist\w*|dxsetup)\.exe$/i;

export const roots = () =>
  [
    env('ProgramFiles'),
    env('ProgramFiles(x86)'),
    `${(env('SystemDrive') || 'C:').replace(/\\+$/, '')}\\PortableApps`,
    `${(env('SystemDrive') || 'C:').replace(/\\+$/, '')}\\Tools`,
    `${(env('SystemDrive') || 'C:').replace(/\\+$/, '')}\\Apps`,
    path.join(homeDir(), 'Apps'),
    path.join(homeDir(), 'PortableApps'),
    path.join(homeDir(), 'Tools'),
  ].filter(Boolean);

const INFO = `
$in = [Console]::In.ReadToEnd() | ConvertFrom-Json
@(foreach ($p in $in) { try { $v = (Get-Item -LiteralPath $p).VersionInfo; [pscustomobject]@{ path = [string]$p; product = [string]$v.ProductName; company = [string]$v.CompanyName; version = [string]$v.ProductVersion } } catch {} }) | ConvertTo-Json -Compress
`;

// Folders with programs in them that no installed program accounts for:
// [{ folder, exe, name, publisher, version, registered }]. `folders` are the folders you added
// (Portable Apps › Add a Folder): each is looked at itself, and each folder inside it is one app.
export async function find(folders = []) {
  const programs = await listDesktop().catch(() => []);
  const locations = programs.map((p) => String(p.location || '').replace(/^"|"$/g, '').replace(/\\+$/, '').toLowerCase()).filter((l) => /^[a-z]:\\./.test(l));
  const registered = new Set(programs.filter((p) => p.portable).map((p) => String(p.location).toLowerCase().replace(/\\+$/, '')));
  const candidates = [];
  const consider = async (folder) => {
    const lower = folder.toLowerCase();
    if (isProtected(folder) || locations.some((l) => l === lower || lower.startsWith(l + '\\') || l.startsWith(lower + '\\'))) {
      if (!registered.has(lower)) return;
    }
    if (/\\(windows|microsoft|common files|windowsapps|modifiablewindowsapps|internet explorer|windows nt|reference assemblies|msbuild)( |\\|$)/i.test(folder)) return;
    const files = (await sys.walk([folder], 1, 2).catch(() => [])).filter((l) => l.startsWith('F') && /\.exe$/i.test(l) && !HELPER.test(l)).map((l) => l.slice(1));
    if (!files.length) return;
    let best = null;
    for (const f of files.slice(0, 30)) {
      const s = await sys.stat(f).catch(() => null);
      if (s && (!best || s.size > best.size)) best = { f, size: s.size };
    }
    candidates.push({ folder, exe: best.f, registered: registered.has(lower) });
  };
  for (const root of roots()) for (const d of (await sys.readDir(root).catch(() => [])).filter((e) => e.dir && !e.link)) await consider(path.join(root, d.name));
  for (const custom of folders.map((f) => f.replace(/\\+$/, '')).filter((f) => /^[a-z]:\\./i.test(f))) {
    await consider(custom);
    for (const d of (await sys.readDir(custom).catch(() => [])).filter((e) => e.dir && !e.link)) await consider(path.join(custom, d.name));
  }
  // A folder can be reached twice (an added folder inside one of the usual places): keep one.
  const seen = new Set();
  for (let i = candidates.length - 1; i >= 0; i--) {
    const k = candidates[i].folder.toLowerCase();
    if (seen.has(k)) candidates.splice(i, 1);
    else seen.add(k);
  }
  const info = candidates.length ? await runPSJson(INFO, { input: JSON.stringify(candidates.map((c) => c.exe)) }).catch(() => []) : [];
  return candidates.map((c) => {
    const i = info.find((x) => x.path.toLowerCase() === c.exe.toLowerCase()) || {};
    return { ...c, name: i.product || path.basename(c.folder), publisher: i.company || '', version: i.version || '' };
  });
}

// Adds the uninstall entry. Removing the program from Windows Settings opens Purgeon.
export async function register(app) {
  if (!/^[a-z]:\\./i.test(app.folder) || isProtected(app.folder)) throw new Error('This folder cannot be registered.');
  const key = `${UNINSTALL}\\${PREFIX}${app.folder.replace(/[^a-z0-9]+/gi, '_').slice(-60)}`;
  const set = async (name, type, data) => {
    const r = await reg(['add', key, '/v', name, '/t', type, '/d', String(data), '/f']);
    if (!r.ok) throw new Error(r.stderr.trim());
  };
  const size = await sys.folderSize(app.folder, 300000, 4000).catch(() => ({ bytes: 0 }));
  await set('DisplayName', 'REG_SZ', app.name);
  await set('DisplayVersion', 'REG_SZ', app.version || '');
  await set('Publisher', 'REG_SZ', app.publisher || '');
  await set('InstallLocation', 'REG_SZ', app.folder);
  await set('DisplayIcon', 'REG_SZ', app.exe);
  await set('EstimatedSize', 'REG_DWORD', Math.round(size.bytes / 1024));
  await set('InstallDate', 'REG_SZ', new Date().toISOString().slice(0, 10).replace(/-/g, ''));
  await set('UninstallString', 'REG_SZ', `"${sys.info.exe}" --uninstall-target "${app.folder}"`);
  await set('NoModify', 'REG_DWORD', 1);
  await set('NoRepair', 'REG_DWORD', 1);
  await set('SweepUninstallPortable', 'REG_DWORD', 1);
  return { key: key.replace(/^HKCU/, 'HKEY_CURRENT_USER'), name: app.name };
}

// Removes only entries Purgeon itself made.
export async function unregister(key) {
  if (!new RegExp(`\\\\Uninstall\\\\${PREFIX}[^\\\\]+$`, 'i').test(key)) throw new Error('Not a portable-app entry made by Purgeon.');
  const r = await reg(['delete', key.replace(/^HKEY_CURRENT_USER/, 'HKCU'), '/f']);
  if (!r.ok && !/unable to find/i.test(r.stderr)) throw new Error(r.stderr.trim());
}

// ---- updates -----------------------------------------------------------------------------------

// Compares dotted versions number by number: -1, 0 or 1.
export function compareVersions(a, b) {
  const pa = String(a || '').match(/\d+/g) || [];
  const pb = String(b || '').match(/\d+/g) || [];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = Number(pa[i] || 0);
    const y = Number(pb[i] || 0);
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// Newer versions of portable apps, looked up in winget's catalogue by the app's name. Nothing is
// downloaded or replaced: each result names the newer version and its download page.
// [{ folder, found, id, latest, newer, homepage }]
export async function checkUpdates(apps) {
  if (!(await winget.available())) throw new Error('Checking for updates uses winget (the Windows Package Manager), which is not installed. Install "App Installer" from the Microsoft Store.');
  const out = [];
  for (const a of apps) {
    const id = await winget.find(a.name).catch(() => null);
    if (!id) {
      out.push({ folder: a.folder, found: false });
      continue;
    }
    const info = await winget.show(id).catch(() => ({}));
    out.push({ folder: a.folder, found: true, id, latest: info.version || '', newer: !!info.version && !!a.version && compareVersions(a.version, info.version) < 0, homepage: info.homepage || '' });
  }
  return out;
}

// Auto-discover portable apps: scan the standard roots plus any folders the user has added,
// and return only the ones not yet registered as Purgeon portable apps.
// [{ folder, exe, name, publisher, version, registered: false }]
export async function discover(folders = []) {
  const all = await find(folders);
  return all.filter((a) => !a.registered);
}
