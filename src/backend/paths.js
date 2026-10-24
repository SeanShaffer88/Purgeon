import { env as getEnv, homeDir } from './sys.js';
import * as path from './winpath.js';
// Well-known locations programs install into, and guards against touching system folders.


const fileRoots = () => {
  const env = envs();
  const home = homeDir();
  return [
    env.ProgramFiles,
    env['ProgramFiles(x86)'],
    env.ProgramData,
    env.APPDATA,
    env.LOCALAPPDATA,
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs'),
    path.join(home, 'AppData', 'LocalLow'),
    env.ProgramFiles && path.join(env.ProgramFiles, 'Common Files'),
    env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Common Files'),
  ].filter(Boolean);
};

const shortcutRoots = () => {
  const env = envs();
  const home = homeDir();
  return [
    env.APPDATA && path.join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    env.ProgramData && path.join(env.ProgramData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(home, 'Desktop'),
    env.PUBLIC && path.join(env.PUBLIC, 'Desktop'),
  ].filter(Boolean);
};

// Environment as an object with the usual Windows names.
const envs = () => new Proxy({}, { get: (_t, k) => getEnv(String(k)) || undefined });

// Folder names too generic to ever treat as belonging to one program.
const GENERIC = new Set(
  [
    'microsoft', 'windows', 'common files', 'commonfiles', 'microsoft shared', 'windowsapps', 'packages',
    'temp', 'programs', 'installer', 'package cache', 'microsoft.net', 'windows defender', 'windows nt',
    'internet explorer', 'windowspowershell', 'reference assemblies', 'msbuild', 'modifiablewindowsapps',
    'start menu', 'desktop', 'system32', 'syswow64', 'crashdumps', 'd3dscache', 'cache', 'logs', 'data',
    'application data', 'google', 'mozilla', 'apple', 'intel', 'amd', 'nvidia', 'nvidia corporation',
    'classes', 'clients', 'policies', 'wow6432node', 'software', 'setup', 'update', 'updater', 'app', 'bin',
  ].map((s) => s.replace(/[^a-z0-9]/g, ''))
);

function isProtected(p) {
  // Only full drive paths are allowed: "C:" or "foo" would otherwise resolve against the current folder.
  if (!p || !/^[a-z]:[\\/]/i.test(p)) return true;
  const n = path.resolve(p).toLowerCase().replace(/[\\/]+$/, '');
  const env = envs();
  const home = homeDir();
  if (n.length <= 3) return true; // drive roots
  const blocked = [
    env.SystemRoot, env.windir, home, env.PUBLIC, path.join(home, 'Desktop'), path.join(home, 'AppData'),
    path.join(home, 'Documents'), ...fileRoots(), ...shortcutRoots(),
    env.APPDATA && path.join(env.APPDATA, 'Microsoft'), env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Microsoft'),
    env.ProgramData && path.join(env.ProgramData, 'Microsoft'),
  ]
    .filter(Boolean)
    .map((b) => path.resolve(b).toLowerCase());
  if (blocked.includes(n)) return true;
  if (env.SystemRoot && n.startsWith(path.resolve(env.SystemRoot).toLowerCase() + '\\')) return true;
  return false;
}

// Registry keys that must never be deleted, whatever a scan or recording suggests.
const HIVES = { hkey_local_machine: 'hklm', hkey_current_user: 'hkcu', hkey_classes_root: 'hkcr', hkey_users: 'hku', hkey_current_config: 'hkcc' };
// Key names under SOFTWARE\Microsoft that belong to Windows itself.
const WINDOWS_KEYS = new Set([
  'windows', 'windows nt', 'windows defender', 'windows search', 'windowsupdate', 'cryptography', 'policies', 'wbem', '.netframework',
  'net framework setup', 'ole', 'rpc', 'security center', 'active setup', 'internet explorer', 'ctf', 'input', 'appmodel', 'wcmsvc',
  'servicing', 'sqmclient', 'tracing', 'userdata', 'msi', 'installer', 'shell', 'deviceaccess', 'dfs', 'ime', 'ncd', 'non-driver signing',
]);
// Shared keys under Classes that many programs and Windows rely on.
const SHARED_CLASSES = new Set(['*', 'clsid', 'directory', 'folder', 'drive', 'allfilesystemobjects', 'applications', 'interface', 'typelib', 'appid', 'systemfileassociations', 'mime', 'lnkfile', 'exefile', 'local settings']);

function isProtectedKey(key) {
  const parts = String(key || '').replace(/^Registry::/i, '').split('\\').filter(Boolean);
  if (!parts.length) return true;
  const hive = HIVES[parts[0].toLowerCase()] || parts[0].toLowerCase();
  if (!['hklm', 'hkcu', 'hkcr', 'hku', 'hkcc'].includes(hive)) return true;
  let rest = parts.slice(1).map((p) => p.toLowerCase());
  if (hive === 'hku') rest = rest.slice(1); // HKU\<sid>\Software\... is a user's HKCU
  if (hive === 'hkcc' || (hive === 'hklm' && rest[0] !== 'software')) return true; // SYSTEM, SAM, SECURITY, HARDWARE...
  if (hive === 'hkcr') rest = ['software', 'classes', ...rest];
  if (rest.length < 2) return true; // a hive root, SOFTWARE, Software, ...
  if (rest[1] === 'wow6432node') rest = [rest[0], ...rest.slice(2)];
  if (rest.length < 2) return true;
  const [, top, ...below] = rest;
  if (top === 'classes') {
    if (!below.length || below[0].startsWith('.')) return true;
    // Registries of IDs (CLSID\{id}) allow one entry; shared types need their own sub-entry (Directory\shell\X).
    const minDepth = ['clsid', 'appid', 'interface', 'typelib'].includes(below[0]) ? 2 : 3;
    return SHARED_CLASSES.has(below[0]) && below.length < minDepth;
  }
  if (top === 'policies' && below.length < 2) return true;
  if (top === 'microsoft') {
    if (!below.length || WINDOWS_KEYS.has(below[0]) && !isProgramEntry(below)) return true;
  }
  return false;
}

// Per-program entries Windows keeps under Microsoft\Windows\CurrentVersion: uninstall entries and App Paths.
const isProgramEntry = (below) => below[0] === 'windows' && below[1] === 'currentversion' && ['uninstall', 'app paths'].includes(below[2]) && below.length === 4;

export { fileRoots, shortcutRoots, GENERIC, isProtected, isProtectedKey };
