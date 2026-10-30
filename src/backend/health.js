// Health Check (Tools › System Tools): plain-words answers to "is this PC
// okay?" — drive health and free space, system-file integrity, a recent
// restore point, pending updates, recent crashes, startup load, battery
// wear. Each check says Pass, Warning, Fail or Couldn't check, with the
// evidence in plain words. Nothing is repaired here; the window points at
// the tool that fixes each thing. The whole run can be cancelled between
// checks, and a check that cannot run says so instead of guessing.
import { runPS, runPSJson } from './shell.js';
import { sys } from './sys.js';
import * as restorepoint from './restorepoint.js';

const check = (id, label, status, detail) => ({ id, label, status, detail });

export function summarize(checks) {
  const done = checks.filter((c) => c.status !== 'unknown');
  if (checks.some((c) => c.status === 'fail')) return { level: 'fail', text: 'Some things need attention — see the Fail lines below.' };
  if (checks.some((c) => c.status === 'warn')) return { level: 'warn', text: 'Mostly healthy — a few warnings worth a look below.' };
  if (!done.length) return { level: 'unknown', text: 'Nothing could be checked on this PC.' };
  return { level: 'pass', text: 'Everything that could be checked looks healthy.' };
}

// DISM /CheckHealth reports one of a few fixed sentences.
export function parseDism(text) {
  const t = String(text || '');
  if (/No component store corruption detected/i.test(t)) return { status: 'pass', detail: 'Windows checked its own system files store and found no damage.' };
  if (/The component store is repairable/i.test(t)) return { status: 'warn', detail: 'Windows found damage in its system files store that it can repair. Run DISM\'s RestoreHealth from an administrator command line, or use Windows Update.' };
  if (/error|failed/i.test(t)) return { status: 'unknown', detail: 'The check itself failed — it needs administrator rights. Restart Purgeon as administrator and run it again.' };
  return { status: 'unknown', detail: 'Windows\' answer could not be read clearly.' };
}

export function freeSpaceStatus(pctFree) {
  if (pctFree === null || pctFree === undefined) return { status: 'unknown', detail: '' };
  if (pctFree < 5) return { status: 'fail', detail: '' };
  if (pctFree < 10) return { status: 'warn', detail: '' };
  return { status: 'pass', detail: '' };
}

export function batteryWearStatus(wearPct) {
  if (wearPct === null || wearPct === undefined) return { status: 'unknown', detail: 'This PC has no battery Windows can report on.' };
  if (wearPct > 40) return { status: 'fail', detail: '' };
  if (wearPct > 20) return { status: 'warn', detail: '' };
  return { status: 'pass', detail: '' };
}

const GB = 1024 ** 3;

async function checkDrives() {
  const drives = await runPSJson(`[System.IO.DriveInfo]::GetDrives() | Where-Object { $_.DriveType -eq 'Fixed' -and $_.IsReady } | ForEach-Object { [pscustomobject]@{ root = $_.RootDirectory.FullName; total = $_.TotalSize; free = $_.AvailableFreeSpace } } | ConvertTo-Json -Compress`).catch(() => null);
  if (!drives) return check('drives', 'Free space', 'unknown', 'The drives could not be read.');
  const list = (Array.isArray(drives) ? drives : [drives]).filter((d) => d && d.total > 0);
  let worst = 'pass';
  const parts = list.map((d) => {
    const pct = Math.round((d.free / d.total) * 100);
    const s = freeSpaceStatus(pct).status;
    if (s === 'fail') worst = 'fail';
    else if (s === 'warn' && worst === 'pass') worst = 'warn';
    return `${String(d.root).slice(0, 2)} ${(d.free / GB).toFixed(1)} GB free (${pct}%)`;
  });
  return check('drives', 'Free space', worst, parts.join(' · ') || 'No fixed drives found.');
}

async function checkSmart() {
  const rows = await runPSJson(`Get-PhysicalDisk -ErrorAction SilentlyContinue | Select-Object FriendlyName, HealthStatus, OperationalStatus | ConvertTo-Json -Compress`).catch(() => null);
  if (!rows) return check('smart', 'Drive health', 'unknown', 'Windows could not report the drives\' health.');
  const list = (Array.isArray(rows) ? rows : [rows]).filter(Boolean);
  if (!list.length) return check('smart', 'Drive health', 'unknown', 'No drives reported a health state.');
  const bad = list.filter((d) => !/healthy/i.test(String(d.HealthStatus || '')) || !/ok/i.test(JSON.stringify(d.OperationalStatus || '')));
  if (bad.length) return check('smart', 'Drive health', 'fail', `${bad.map((d) => d.FriendlyName || 'A drive').join(', ')} report${bad.length === 1 ? 's' : ''} a health problem. Back up anything important on ${bad.length === 1 ? 'it' : 'them'} now.`);
  return check('smart', 'Drive health', 'pass', list.map((d) => `${d.FriendlyName || 'Drive'}: healthy`).join(' · '));
}

async function checkFiles(runSfc) {
  const dism = await sys.exec('dism.exe', ['/Online', '/Cleanup-Image', '/CheckHealth']).catch(() => null);
  const d = parseDism(dism ? `${dism.stdout || ''} ${dism.stderr || ''}` : '');
  if (!runSfc) return check('files', 'System files', d.status, d.detail);
  const sfc = await sys.exec('sfc.exe', ['/verifyonly']).catch(() => null);
  const st = sfc ? `${sfc.stdout || ''}` : '';
  let s;
  if (/did not find any integrity violations/i.test(st)) s = { status: 'pass', detail: 'Windows verified its system files and found no problems.' };
  else if (/found corrupt files/i.test(st)) s = { status: 'warn', detail: 'Windows found some damaged system files. Running "sfc /scannow" as administrator repairs them.' };
  else s = { status: 'unknown', detail: 'The full file verification\'s answer could not be read clearly (it needs administrator rights).' };
  const rank = { pass: 0, unknown: 1, warn: 2, fail: 3 };
  const merged = rank[s.status] > rank[d.status] ? s : d;
  return check('files', 'System files', merged.status, `${d.detail} ${s === merged ? '' : s.detail}`.trim());
}

async function checkRestore() {
  const points = await restorepoint.list().catch(() => []);
  if (!Array.isArray(points) || !points.length) return check('restore', 'Restore point', 'warn', 'No restore points exist. If anything goes wrong there is nothing to roll back to — create one in System Restore (Tools › System Tools).');
  const newest = points[0];
  const m = String(newest.CreationTime || '').match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) return check('restore', 'Restore point', 'pass', `${points.length} restore point${points.length === 1 ? '' : 's'} exist.`);
  const ageDays = Math.floor((Date.now() - Date.UTC(+m[1], +m[2] - 1, +m[3])) / 86400000);
  if (ageDays > 30) return check('restore', 'Restore point', 'warn', `The newest restore point is ${ageDays} days old. A fresher one is safer — create one in System Restore.`);
  return check('restore', 'Restore point', 'pass', `The newest restore point is ${ageDays === 0 ? 'from today' : `${ageDays} day${ageDays === 1 ? '' : 's'} old`}.`);
}

async function checkUpdates() {
  const out = await runPS(`$s = New-Object -ComObject Microsoft.Update.Session
$q = $s.CreateUpdateSearcher()
$r = $q.Search("IsInstalled=0 and Type='Software'")
[pscustomobject]@{ count = $r.Updates.Count } | ConvertTo-Json -Compress`).catch(() => '');
  try {
    const { count } = JSON.parse(out.trim());
    if (count === 0) return check('updates', 'Windows updates', 'pass', 'No updates are waiting.');
    return check('updates', 'Windows updates', 'warn', `${count} update${count === 1 ? ' is' : 's are'} waiting in Windows Update.`);
  } catch {
    return check('updates', 'Windows updates', 'unknown', 'Windows Update could not be asked — it may be busy or turned off by policy.');
  }
}

async function checkCrashes() {
  const rows = await runPSJson(`Get-WinEvent -FilterHashtable @{ LogName = 'Application'; Level = 2; StartTime = (Get-Date).AddDays(-7) } -MaxEvents 300 -ErrorAction SilentlyContinue | Where-Object { $_.ProviderName -in 'Application Error', 'Windows Error Reporting', 'Application Hang' } | Group-Object ProviderName | Select-Object Name, Count | ConvertTo-Json -Compress`).catch(() => null);
  if (rows === null) return check('crashes', 'Recent crashes', 'unknown', 'The event log could not be read.');
  const list = (Array.isArray(rows) ? rows : [rows]).filter(Boolean);
  const total = list.reduce((n, r) => n + (Number(r.Count) || 0), 0);
  if (total === 0) return check('crashes', 'Recent crashes', 'pass', 'No program crashes were recorded in the last 7 days.');
  return check('crashes', 'Recent crashes', 'warn', `${total} program crash${total === 1 ? '' : 'es'} recorded in the last 7 days (${list.map((r) => `${r.Name}: ${r.Count}`).join(', ')}). Occasional crashes are normal; the same program crashing daily is worth a look.`);
}

async function checkStartup(count) {
  if (typeof count !== 'number') return check('startup', 'Startup load', 'unknown', 'Startup entries could not be counted.');
  if (count > 20) return check('startup', 'Startup load', 'warn', `${count} things start with Windows — that many will slow sign-in down. Startup & Services shows them all.`);
  if (count > 10) return check('startup', 'Startup load', 'warn', `${count} things start with Windows. Startup & Services can trim the ones you do not need.`);
  return check('startup', 'Startup load', 'pass', `${count} thing${count === 1 ? '' : 's'} start${count === 1 ? 's' : ''} with Windows.`);
}

async function checkBattery() {
  const [row] = await runPSJson(`$full = Get-CimInstance -Namespace root\\wmi -ClassName BatteryFullChargedCapacity -ErrorAction SilentlyContinue | Select-Object -First 1
$design = Get-CimInstance -Namespace root\\wmi -ClassName BatteryStaticData -ErrorAction SilentlyContinue | Select-Object -First 1
[pscustomobject]@{ full = $full.FullChargedCapacity; design = $design.DesignedCapacity } | ConvertTo-Json -Compress`).catch(() => []);
  const full = Number(row?.full);
  const design = Number(row?.design);
  if (!full || !design) return check('battery', 'Battery health', 'unknown', 'This PC has no battery Windows can report on.');
  const wear = Math.round((1 - full / design) * 100);
  const s = batteryWearStatus(wear);
  return check('battery', 'Battery health', s.status, `The battery holds ${Math.max(0, 100 - wear)}% of the charge it had when new (${wear}% wear).`);
}

export async function runChecks({ runSfc = false, startupCount = null, shouldStop = () => false } = {}) {
  const steps = [
    () => checkDrives(),
    () => checkSmart(),
    () => checkFiles(runSfc),
    () => checkRestore(),
    () => checkUpdates(),
    () => checkCrashes(),
    () => checkStartup(startupCount),
    () => checkBattery(),
  ];
  const out = [];
  for (const step of steps) {
    if (shouldStop()) return { checks: out, cancelled: true, summary: summarize(out) };
    out.push(await step().catch((e) => check('error', 'Check', 'unknown', String(e.message || e))));
  }
  return { checks: out, cancelled: false, summary: summarize(out) };
}
