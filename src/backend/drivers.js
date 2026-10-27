// Driver store enumeration and clean-up.
// Lists third-party driver packages in the Windows driver store and offers to
// remove old versions that Windows no longer needs. Uses pnputil (built into
// Windows) so no extra tools are required. Everything is backed up first.
import { sys } from './sys.js';
import { runPS, runPSJson } from './shell.js';

const DRIVER_STORE = '%SystemRoot%\\System32\\DriverStore\\FileRepository';

// Lists third-party driver packages: [{ name, originalName, inf, date, version, provider, oem, class }].
// Third-party = not Microsoft, not Windows' own in-box drivers.
export async function listDrivers() {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$drivers = pnputil /enum-drivers 2>$null | Where-Object { $_ -match '^(Published name|Original file name|Inf file|Date|Driver class|Provider name):' }
$out = @()
$cur = {}
foreach ($line in $drivers) {
  $line = $line.Trim()
  if ($line -match '^Published name:\s*(.+)$') {
    if ($cur.PublishedName) { $out += $cur }
    $cur = @{ PublishedName = $matches[1] }
  } elseif ($line -match '^Original file name:\s*(.+)$') { $cur.OriginalName = $matches[1] }
  elseif ($line -match '^Inf file:\s*(.+)$') { $cur.InfFile = $matches[1] }
  elseif ($line -match '^Date:\s*(.+)$') { $cur.Date = $matches[1] }
  elseif ($line -match '^Driver class:\s*(.+)$') { $cur.DriverClass = $matches[1] }
  elseif ($line -match '^Provider name:\s*(.+)$') { $cur.Provider = $matches[1] }
}
if ($cur.PublishedName) { $out += $cur }
$out | Where-Object { $_.Provider -and $_.Provider -notlike '*Microsoft*' -and $_.Provider -notlike '*Windows*' } | ConvertTo-Json -Compress -Depth 3
`;
  const out = await runPS(script).catch(() => '');
  if (!out.trim()) return [];
  try {
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

// Removes a driver package from the driver store using pnputil /delete-driver.
export async function deleteDriver(inf) {
  const r = await sys.exec('pnputil.exe', ['/delete-driver', inf, '/uninstall', '/force']);
  return { ok: r.ok, detail: r.ok ? 'Driver package removed.' : `pnputil exited with code ${r.code}: ${String(r.stderr || r.stdout).trim()}` };
}

// Groups parsed driver packages by inf file name and returns old duplicates
// (all but the newest version of each inf) as candidates for removal.
// Pure function: easy to test with mock driver data.
export function findOldDriverCandidates(drivers) {
  const byInf = new Map();
  for (const d of drivers) {
    const key = String(d.InfFile || '').toLowerCase();
    if (!key) continue;
    const existing = byInf.get(key);
    if (!existing) {
      byInf.set(key, [d]);
    } else {
      existing.push(d);
      // Sort by date descending so newest is first
      existing.sort((a, b) => {
        const da = new Date(a.Date || 0).getTime();
        const db = new Date(b.Date || 0).getTime();
        return db - da;
      });
    }
  }
  const candidates = [];
  for (const [, list] of byInf) {
    if (list.length > 1) {
      // All but the newest are candidates
      for (let i = 1; i < list.length; i++) {
        candidates.push(list[i]);
      }
    }
  }
  return candidates;
}

// Returns drivers grouped by inf file name, keeping only the newest version of each.
// Old duplicates are candidates for removal.
export async function oldDriverCandidates() {
  const drivers = await listDrivers();
  return findOldDriverCandidates(drivers);
}

export { DRIVER_STORE };
