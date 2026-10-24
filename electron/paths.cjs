// Well-known locations programs install into, and guards against touching system folders.
const path = require('path');
const os = require('os');

const env = process.env;
const home = os.homedir();

const fileRoots = () =>
  [
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

const shortcutRoots = () =>
  [
    env.APPDATA && path.join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    env.ProgramData && path.join(env.ProgramData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(home, 'Desktop'),
    env.PUBLIC && path.join(env.PUBLIC, 'Desktop'),
  ].filter(Boolean);

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

module.exports = { fileRoots, shortcutRoots, GENERIC, isProtected };
