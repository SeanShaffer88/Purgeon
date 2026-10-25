// What runs without being started: the measured start-up delay each program caused (from
// Windows' own boot performance records), and programs allowed to accept incoming connections.
import { runPSJson } from './shell.js';
import { sys } from './sys.js';
import * as path from './winpath.js';

// Windows logs slow boots in Microsoft-Windows-Diagnostics-Performance/Operational:
// event 100 is a boot with its duration; 101 (programs), 103 (services) and 102/104-110
// (drivers, devices, shell) name what made it slower and by how much. Reading needs administrator rights.
const BOOT_EVENTS = `
$events = Get-WinEvent -LogName 'Microsoft-Windows-Diagnostics-Performance/Operational' -MaxEvents 1500 -ErrorAction Stop | Where-Object { $_.Id -ge 100 -and $_.Id -le 110 }
$boots = New-Object System.Collections.ArrayList
$items = New-Object System.Collections.ArrayList
foreach ($e in $events) {
  $d = @{}
  foreach ($n in ([xml]$e.ToXml()).Event.EventData.Data) { $d[$n.Name] = $n.'#text' }
  if ($e.Id -eq 100) { [void]$boots.Add([pscustomobject]@{ time = $e.TimeCreated.ToUniversalTime().ToString('o'); mainPathMs = [int]$d.MainPathBootTime; bootMs = [int]$d.BootTime }) }
  else {
    $name = if ($d.FileName) { $d.FileName } else { $d.Name }
    if ($name) { [void]$items.Add([pscustomobject]@{ id = $e.Id; name = [string]$name; friendly = [string]$d.FriendlyName; delayMs = [int]$d.DegradationTime; time = $e.TimeCreated.ToUniversalTime().ToString('o') }) }
  }
}
[pscustomobject]@{ boots = @($boots); items = @($items) } | ConvertTo-Json -Compress -Depth 4
`;

// { available, boots: [{ time, mainPathMs, bootMs }], impact: { [lowercased exe or service name]: { friendly, times, avgMs, last } } }
export async function bootImpact() {
  let raw;
  try {
    [raw] = await runPSJson(BOOT_EVENTS);
  } catch {
    return { available: false, boots: [], impact: {} };
  }
  const impact = {};
  for (const i of raw?.items || []) {
    const k = i.name.toLowerCase().split('\\').pop();
    const e = (impact[k] = impact[k] || { friendly: i.friendly, times: 0, totalMs: 0, last: i.time });
    e.times++;
    e.totalMs += i.delayMs;
    if (i.time > e.last) e.last = i.time;
  }
  for (const e of Object.values(impact)) e.avgMs = Math.round(e.totalMs / e.times);
  return { available: true, boots: (raw?.boots || []).slice(0, 20), impact };
}

// Enabled inbound "allow" firewall rules for programs outside the Windows folder.
const INBOUND = `
$rules = Get-NetFirewallRule -Direction Inbound -Action Allow -Enabled True -ErrorAction SilentlyContinue
$apps = @{}
foreach ($f in Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue) { if ($f.Program -and $f.Program -ne 'Any' -and $f.Program -ne 'System') { $apps[$f.InstanceID] = $f.Program } }
@(foreach ($r in $rules) {
  $prog = $apps[$r.Name]
  if (-not $prog) { continue }
  $exp = [Environment]::ExpandEnvironmentVariables($prog)
  if ($exp -match '^[a-z]:\\\\Windows\\\\' -or $r.Group -like '@*') { continue }
  [pscustomobject]@{ name = $r.Name; display = $r.DisplayName; program = $exp; profile = [string]$r.Profile; exists = [bool](Test-Path -LiteralPath $exp) }
}) | ConvertTo-Json -Compress
`;

// One entry per program: { program, display, names: [rule names], profiles, exists }.
export async function inboundRules() {
  const rules = await runPSJson(INBOUND).catch(() => []);
  const byProgram = new Map();
  for (const r of rules) {
    const k = r.program.toLowerCase();
    const e = byProgram.get(k) || { program: r.program, display: r.display, names: [], profiles: new Set(), exists: r.exists };
    e.names.push(r.name);
    String(r.profile || '').split(/,\s*/).filter(Boolean).forEach((p) => e.profiles.add(p));
    byProgram.set(k, e);
  }
  return [...byProgram.values()].map((e) => ({ ...e, name: e.names[0], profile: [...e.profiles].join(', ') })).sort((a, b) => a.display.localeCompare(b.display));
}

// ---- startup trust check and new-entry alerts ------------------------------------------------

const RANDOM_NAME = /\\(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{8,}\\|\\\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?\\/i;

// Reasons to look twice at a startup entry: it runs from Temp or Downloads, from a randomly
// named folder in AppData, its file is unsigned, or the file appeared in the last week.
export function trustReasons(command, sig, created, now = Date.now()) {
  const c = String(command || '').toLowerCase();
  const reasons = [];
  if (/\\(temp|tmp)\\|\\downloads\\/.test(c)) reasons.push('Runs from a Temp or Downloads folder');
  else if (/\\appdata\\/.test(c) && RANDOM_NAME.test(c.replace(/\\appdata\\(local|roaming|locallow)\\(programs|microsoft)\\/, '\\'))) reasons.push('Runs from a randomly named folder in AppData');
  if (sig && sig.status && sig.status !== 'Valid') reasons.push(sig.status === 'NotSigned' ? 'Not digitally signed' : `Signature problem: ${sig.status}`);
  if (created && now - created < 7 * 86400000) reasons.push('Its program file appeared in the last 7 days');
  return reasons;
}

let baselineFile = '';
export const setRoot = async (dir) => {
  await sys.makeDir(dir);
  baselineFile = path.join(dir, 'startup-baseline.json');
};

// Startup entries that are new (or now run something else) since they were last accepted.
// The first look only records what is there.
export async function newEntries(entries) {
  const base = await sys.readText(baselineFile).then(JSON.parse).catch(() => null);
  const now = Object.fromEntries(entries.map((e) => [e.id, e.command || '']));
  if (!base) {
    await sys.writeText(baselineFile, JSON.stringify(now));
    return [];
  }
  return entries.filter((e) => e.enabled !== false && (base[e.id] === undefined || base[e.id] !== (e.command || '')));
}

// Accepts entries into the baseline (so they are not reported again).
export async function accept(entries) {
  const base = await sys.readText(baselineFile).then(JSON.parse).catch(() => ({}));
  for (const e of entries) base[e.id] = e.command || '';
  await sys.writeText(baselineFile, JSON.stringify(base));
}
