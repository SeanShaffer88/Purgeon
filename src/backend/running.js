// What runs without being started: the measured start-up delay each program caused (from
// Windows' own boot performance records), and programs allowed to accept incoming connections.
import { runPSJson } from './shell.js';

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
