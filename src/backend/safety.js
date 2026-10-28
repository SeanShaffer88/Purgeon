// Checks made right before anything is deleted, and warnings about programs others rely on.
//
// The re-check runs at removal time, not at scan time, so it sees the system as it is now:
// - a folder or file that belongs to (or contains) another installed program is skipped;
// - a file Windows counts as shared by several programs (SharedDLLs) is skipped, and so is
//   a folder holding one;
// - another installed program's uninstall entry is skipped.
// The programs being removed are named as owners and are not counted as "other programs".
import { runPSJson } from './shell.js';
import * as path from './winpath.js';
import { isProtected } from './paths.js';

const READ_STATE = `
$programs = foreach ($root in 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall') {
  foreach ($k in Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue) {
    $p = Get-ItemProperty -LiteralPath $k.PSPath -ErrorAction SilentlyContinue
    if (-not $p.DisplayName) { continue }
    [pscustomobject]@{ key = $k.Name; name = [string]$p.DisplayName; location = [string]$p.InstallLocation }
  }
}
$shared = foreach ($root in 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\SharedDLLs','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\SharedDLLs') {
  $k = Get-Item -LiteralPath $root -ErrorAction SilentlyContinue
  if (-not $k) { continue }
  foreach ($v in $k.GetValueNames()) { $n = $k.GetValue($v); if ($n -is [int] -and $n -gt 1) { [pscustomobject]@{ path = $v; count = $n } } }
}
[pscustomobject]@{ programs = @($programs); shared = @($shared) } | ConvertTo-Json -Compress -Depth 4
`;

const longKey = (k) =>
  String(k || '')
    .replace(/^HKLM\\/i, 'HKEY_LOCAL_MACHINE\\')
    .replace(/^HKCU\\/i, 'HKEY_CURRENT_USER\\')
    .toLowerCase();
const cleanDir = (p) => String(p || '').replace(/^"|"$/g, '').trim().replace(/[\\/]+$/, '');
const inside = (child, parent) => {
  const c = path.resolve(child).toLowerCase();
  const p = path.resolve(parent).toLowerCase();
  return c === p || c.startsWith(p + '\\');
};

// Reads installed programs and shared-file counts: { programs: [{ key, name, location }], shared: [{ path, count }] }.
export async function readState() {
  const [s] = await runPSJson(READ_STATE);
  return { programs: s?.programs || [], shared: s?.shared || [] };
}

// Why an item must be left alone given the current state, or null when it may go.
// `owners` are the uninstall keys of the programs being removed.
export function guardReason(item, state, owners = []) {
  const own = new Set(owners.map(longKey));
  const others = state.programs.filter((p) => !own.has(longKey(p.key)));
  if (item.kind === 'dir' || item.kind === 'file') {
    for (const p of others) {
      const loc = cleanDir(p.location);
      if (!/^[a-z]:\\/i.test(loc) || isProtected(loc)) continue;
      if (inside(item.path, loc) || (item.kind === 'dir' && inside(loc, item.path))) return `Used by ${p.name}, which is still installed`;
    }
    for (const s of state.shared) {
      if (item.kind === 'file' ? path.resolve(s.path).toLowerCase() === path.resolve(item.path).toLowerCase() : inside(s.path, item.path)) {
        return `Shared file used by ${s.count} programs (${path.basename(s.path)})`;
      }
    }
  }
  if (item.kind === 'key') {
    const hit = others.find((p) => longKey(p.key) === longKey(item.path) || longKey(p.key).startsWith(longKey(item.path) + '\\'));
    if (hit) return `Uninstall entry of ${hit.name}, which is still installed`;
  }
  return null;
}

// ---- dependency warnings ------------------------------------------------------

// Shared runtimes and hardware support software: removing one can break other programs or devices.
export const RUNTIMES = /visual c\+\+ .*redistributable|\bvc_?redist|\.net (framework|runtime|desktop runtime|core)|asp\.net core|windows desktop runtime|windows app ?(runtime|sdk)|java(\(tm\))? (\d|se)|\bjre\b|\bjdk\b|directx|webview2 runtime|xna framework|openal|vulkan ?run ?time|physx|access database engine|sql server .*(native client|odbc|localdb|clr types|shared management)|msxml|visual studio tools for office|universal crt|windows sdk|python launcher/i;
const DRIVERS = /\bdriver|chipset|graphics|audio|bluetooth|wireless|wi-?fi|ethernet|\blan\b|management engine|rapid storage|serial io|thunderbolt|control panel|touchpad|synaptics|elan|realtek|hd audio/i;
const HARDWARE_MAKERS = /intel|nvidia|amd|advanced micro devices|realtek|qualcomm|broadcom|mediatek|synaptics|elan|conexant|dolby|waves|logitech|razer|corsair|steelseries/i;

const READ_DEPENDENTS = `
$in = [Console]::In.ReadToEnd() | ConvertFrom-Json
$ids = @{}
foreach ($root in 'HKLM:\\SOFTWARE\\Classes\\Installer\\Dependencies','HKCU:\\Software\\Classes\\Installer\\Dependencies') {
  foreach ($k in Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue) {
    $owner = [string](Get-ItemProperty -LiteralPath $k.PSPath -ErrorAction SilentlyContinue).'(default)'
    if (-not $owner) { $owner = $k.PSChildName }
    if ($owner -ne $in.id -and $k.PSChildName -ne $in.id) { continue }
    foreach ($d in Get-ChildItem -LiteralPath (Join-Path $k.PSPath 'Dependents') -ErrorAction SilentlyContinue) { $ids[$d.PSChildName] = 1 }
  }
}
@($ids.Keys) | ConvertTo-Json -Compress
`;

// What depends on a program: { kind: 'runtime' | 'driver' | null, dependents: [names], note }.
// Dependents come from Windows Installer's dependency records, which runtime packages such as
// Visual C++ and .NET use to count the programs that installed them.
export async function dependencyInfo(program) {
  const id = String(program.key || '').split('\\').pop();
  const { programs } = await readState().catch(() => ({ programs: [] }));
  const ids = id ? await runPSJson(READ_DEPENDENTS, { input: JSON.stringify({ id }) }).catch(() => []) : [];
  const byLeaf = new Map(programs.map((p) => [String(p.key).split('\\').pop().toLowerCase(), p.name]));
  const dependents = [...new Set(ids.map((d) => byLeaf.get(String(d).toLowerCase())).filter((n) => n && n !== program.name))];
  const unknown = ids.length - dependents.length;
  return classify(program, dependents, unknown);
}

export function classify(program, dependents = [], unknown = 0) {
  const text = `${program.name} ${program.publisher || ''}`;
  const kind = RUNTIMES.test(program.name) ? 'runtime' : HARDWARE_MAKERS.test(text) && DRIVERS.test(program.name) ? 'driver' : null;
  const lines = [];
  if (kind === 'runtime') lines.push(`${program.name} is a shared runtime. Other programs may need it to start.`);
  if (kind === 'driver') lines.push(`${program.name} looks like hardware driver or support software. Removing it can stop a device from working.`);
  if (dependents.length) lines.push(`Installed programs that registered a need for it: ${dependents.join(', ')}.`);
  else if (unknown > 0) lines.push(`${unknown} other installation${unknown === 1 ? '' : 's'} registered a need for it.`);
  return { kind, dependents, unknown, note: lines.join(' ') };
}
