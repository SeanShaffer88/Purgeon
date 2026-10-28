// Games (Tools › Advanced Tools): what the game launchers say is installed.
// Detection is launcher-based and read-only — Steam's library files, Epic's
// manifests, GOG's registry entries. Uninstalling a game stays with its
// launcher (that is where the files and the account live); Purgeon's part is
// measuring the folders and cleaning up the entry of a game whose files are
// already gone, through the standard backed-up removal.
import { sys, env } from './sys.js';
import * as path from './winpath.js';
import { runPSJson } from './shell.js';

// --- Pure parsers (unit-tested) -------------------------------------------

// Steam's libraryfolders.vdf: every "path" value, in order.
export function parseLibraryFolders(text) {
  const out = [];
  const re = /"path"\s+"((?:[^"\\]|\\.)*)"/gi;
  let m;
  while ((m = re.exec(String(text || '')))) out.push(m[1].replace(/\\\\/g, '\\'));
  return out;
}

// One appmanifest_*.acf: the AppState block's name and install folder.
export function parseAcf(text) {
  const t = String(text || '');
  const pick = (key) => {
    const m = new RegExp(`"${key}"\\s+"((?:[^"\\\\]|\\\\.)*)"`, 'i').exec(t);
    return m ? m[1].replace(/\\\\/g, '\\') : '';
  };
  const name = pick('name');
  const installdir = pick('installdir');
  if (!name || !installdir) return null;
  return { name, installdir, appid: pick('appid') };
}

// One Epic .item manifest (JSON): display name and install location.
export function parseEpicManifest(text) {
  try {
    const j = JSON.parse(String(text || ''));
    if (!j.DisplayName || !j.InstallLocation) return null;
    return { name: String(j.DisplayName), location: String(j.InstallLocation), app: String(j.AppName || '') };
  } catch {
    return null;
  }
}

// One GOG registry entry, as returned by the PowerShell read below.
export function shapeGog(entry) {
  if (!entry || !entry.path || !entry.name) return null;
  return { name: String(entry.name), launcher: 'GOG', location: String(entry.path), entryKind: 'key', entryPath: String(entry.key || '') };
}

export function shapeGame({ name, launcher, location, entryKind, entryPath }) {
  return { name, launcher, location: location || '', entryKind: entryKind || 'file', entryPath: entryPath || '', size: 0, present: false };
}

// --- Detection --------------------------------------------------------------

const STEAM_FALLBACKS = ['C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam'];

async function steamRoot() {
  const [row] = await runPSJson(
    `$p = Get-ItemProperty 'HKCU:\\SOFTWARE\\Valve\\Steam' -ErrorAction SilentlyContinue; if ($p -and $p.SteamPath) { [pscustomobject]@{ path = $p.SteamPath } | ConvertTo-Json -Compress }`,
  ).catch(() => []);
  if (row?.path) return String(row.path).replace(/\//g, '\\');
  for (const c of STEAM_FALLBACKS) if (await sys.exists(c)) return c;
  return null;
}

async function steamGames() {
  const root = await steamRoot();
  if (!root) return [];
  const libraries = new Set([root]);
  const vdf = await sys.readText(path.join(root, 'steamapps', 'libraryfolders.vdf')).catch(() => '');
  for (const lib of parseLibraryFolders(vdf)) libraries.add(lib);
  const out = [];
  for (const lib of libraries) {
    const appsDir = path.join(lib, 'steamapps');
    const entries = await sys.readDir(appsDir).catch(() => []);
    for (const e of entries) {
      if (!/^appmanifest_\d+\.acf$/i.test(e.name)) continue;
      const manifestPath = path.join(appsDir, e.name);
      const acf = parseAcf(await sys.readText(manifestPath).catch(() => ''));
      if (!acf) continue;
      out.push(shapeGame({ name: acf.name, launcher: 'Steam', location: path.join(appsDir, 'common', acf.installdir), entryPath: manifestPath }));
    }
  }
  return out;
}

async function epicGames() {
  const dir = path.join(env.ProgramData || 'C:\\ProgramData', 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests');
  const entries = await sys.readDir(dir).catch(() => []);
  const out = [];
  for (const e of entries) {
    if (!/\.item$/i.test(e.name)) continue;
    const manifestPath = path.join(dir, e.name);
    const item = parseEpicManifest(await sys.readText(manifestPath).catch(() => ''));
    if (item) out.push(shapeGame({ name: item.name, launcher: 'Epic', location: item.location, entryPath: manifestPath }));
  }
  return out;
}

async function gogGames() {
  const rows = await runPSJson(
    `$base = 'HKLM:\\SOFTWARE\\WOW6432Node\\GOG.com\\Games'; if (Test-Path $base) { Get-ChildItem $base | ForEach-Object { $p = Get-ItemProperty $_.PSPath; [pscustomobject]@{ key = ('HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games\\' + $_.PSChildName); name = $p.gameName; path = $p.path } } | ConvertTo-Json -Compress }`,
  ).catch(() => []);
  return rows.map(shapeGog).filter(Boolean).map((g) => shapeGame(g));
}

// Every detected game, de-duplicated by folder, with presence checked and
// folder sizes measured for the games that are there.
export async function list() {
  const all = [...(await steamGames().catch(() => [])), ...(await epicGames().catch(() => [])), ...(await gogGames().catch(() => []))];
  const byLocation = new Map();
  for (const g of all) {
    const key = (g.location || g.name).toLowerCase();
    if (!byLocation.has(key)) byLocation.set(key, g);
  }
  const games = [...byLocation.values()];
  // Presence and sizes are measured three at a time — a big library should
  // not keep the window waiting on one folder after another.
  const queue = [...games];
  const worker = async () => {
    while (queue.length) {
      const g = queue.shift();
      g.present = g.location ? await sys.exists(g.location).catch(() => false) : false;
      if (g.present) {
        const size = await sys.folderSize(g.location, 2000000, 20000).catch(() => null);
        g.size = size ? size.bytes || 0 : 0;
        g.partial = !!(size && size.truncated);
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return games.sort((a, b) => a.name.localeCompare(b.name));
}
