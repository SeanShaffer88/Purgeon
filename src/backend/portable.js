// Portable apps: programs that run from a folder without an installer, so Windows doesn't list
// them. Registering one adds a per-user uninstall entry (marked as SweepUninstall's), so it gets
// an icon, a group, leftover scans and a clean removal like any installed program.
import { sys, env, homeDir } from './sys.js';
import * as path from './winpath.js';
import { reg, runPSJson } from './shell.js';
import { listDesktop } from './programs.js';
import { isProtected } from './paths.js';

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
// [{ folder, exe, name, publisher, version, registered }]. `extra` adds folders you chose.
export async function find(extra = []) {
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
  for (const f of extra) await consider(f.replace(/\\+$/, ''));
  const info = candidates.length ? await runPSJson(INFO, { input: JSON.stringify(candidates.map((c) => c.exe)) }).catch(() => []) : [];
  return candidates.map((c) => {
    const i = info.find((x) => x.path.toLowerCase() === c.exe.toLowerCase()) || {};
    return { ...c, name: i.product || path.basename(c.folder), publisher: i.company || '', version: i.version || '' };
  });
}

// Adds the uninstall entry. Removing the program from Windows Settings opens SweepUninstall.
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

// Removes only entries SweepUninstall itself made.
export async function unregister(key) {
  if (!new RegExp(`\\\\Uninstall\\\\${PREFIX}[^\\\\]+$`, 'i').test(key)) throw new Error('Not a portable-app entry made by SweepUninstall.');
  const r = await reg(['delete', key.replace(/^HKEY_CURRENT_USER/, 'HKCU'), '/f']);
  if (!r.ok && !/unable to find/i.test(r.stderr)) throw new Error(r.stderr.trim());
}
