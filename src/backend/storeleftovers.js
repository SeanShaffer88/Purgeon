// Store app deep leftover scan. When a Microsoft Store app is uninstalled, Windows leaves
// per-user package data under %LOCALAPPDATA%\Packages, %LOCALAPPDATA%\Microsoft\WindowsApps,
// and registry activatable-class entries. This scanner finds those orphaned locations so the
// user can review and remove them, following Purgeon's protection rules.
import { sys, env, homeDir } from './sys.js';
import * as path from './winpath.js';
import { runPSJson } from './shell.js';
import { isProtected, isProtectedKey } from './paths.js';

const LOCALAPPDATA = env('LOCALAPPDATA') || path.join(homeDir(), 'AppData', 'Local');
const PACKAGES_DIR = path.join(LOCALAPPDATA, 'Packages');
const WINDOWSAPPS_DIR = path.join(LOCALAPPDATA, 'Microsoft', 'WindowsApps');

// Registry locations where Store apps register activatable classes and extension points.
const REG_LOCATIONS = [
  'HKCU\\Software\\Classes\\ActivatableClasses\\Package',
  'HKCU\\Software\\Classes\\Extensions\\Package',
];

// List installed Store apps (package family names) so we know which packages are still valid.
async function installedStorePackages() {
  const script = `
Get-AppxPackage -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty PackageFamilyName |
  ConvertTo-Json -Compress
`;
  try {
    return await runPSJson(script);
  } catch {
    return [];
  }
}

// Scan the Packages folder for folders whose package family is no longer installed.
async function scanPackages(validFamilies) {
  const valid = new Set(validFamilies.map((f) => String(f).toLowerCase()));
  const leftovers = [];
  const entries = await sys.readDir(PACKAGES_DIR).catch(() => []);
  for (const e of entries) {
    if (!e.dir || e.link) continue;
    // Package folder names look like "PackageName_Version_ABCDEFGH1234"
    const pf = e.name.split('_').pop() || '';
    // If the folder name doesn't contain a recognizable package family pattern, still flag it
    // if it doesn't match any known installed family.
    const family = e.name.toLowerCase();
    if (!valid.has(family) && !valid.some((v) => family.includes(v.replace(/_.*$/, '')))) {
      leftovers.push({
        kind: 'dir',
        path: path.join(PACKAGES_DIR, e.name),
        name: e.name,
        confidence: 'medium',
        reason: `Store package folder no longer installed: ${e.name}`,
      });
    }
  }
  return leftovers;
}

// Scan WindowsApps for .exe files whose package is no longer installed.
async function scanWindowsApps(validFamilies) {
  const valid = new Set(validFamilies.map((f) => String(f).toLowerCase()));
  const leftovers = [];
  try {
    const files = (await sys.walk([WINDOWSAPPS_DIR], 1, 1).catch(() => [])).filter(
      (l) => l.startsWith('F') && /\.exe$/i.test(l)
    );
    for (const f of files) {
      const full = f.slice(1);
      const parent = path.dirname(full).toLowerCase();
      if (!valid.some((v) => parent.includes(v.replace(/_.*$/, '')))) {
        leftovers.push({
          kind: 'file',
          path: full,
          name: path.basename(full),
          confidence: 'low',
          reason: `Store app executable with no installed package: ${path.basename(full)}`,
        });
      }
    }
  } catch {}
  return leftovers;
}

// Scan registry activatable-class locations for orphaned package entries.
async function scanRegistry() {
  const leftovers = [];
  for (const loc of REG_LOCATIONS) {
    try {
      const rows = await runPSJson(
        `Get-ChildItem -LiteralPath 'Registry::${loc}' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty PSChildName | ConvertTo-Json -Compress`
      );
      const valid = await installedStorePackages();
      for (const name of rows) {
        const n = String(name).toLowerCase();
        if (!valid.some((v) => n.includes(v.replace(/_.*$/, '')))) {
          leftovers.push({
            kind: 'key',
            path: `${loc}\\${name}`,
            name,
            confidence: 'medium',
            reason: `Orphaned Store app activatable class: ${name}`,
          });
        }
      }
    } catch {}
  }
  return leftovers;
}

// Run a full Store-app leftover scan.
export async function scan() {
  const valid = await installedStorePackages();
  const [packages, apps, registry] = await Promise.all([
    scanPackages(valid),
    scanWindowsApps(valid),
    scanRegistry(),
  ]);
  const items = [...packages, ...apps, ...registry];
  return {
    storeLeftovers: items,
    scanned: items.length,
    time: new Date().toISOString(),
  };
}
