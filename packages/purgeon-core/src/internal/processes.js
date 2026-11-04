// Live process monitoring and control: the Processes view's data and actions.
// One PowerShell sample returns every process with its CPU time so far; the
// per-process CPU percentage is worked out here from the change since the
// previous sample (that part is pure and tested). Totals (processor, memory,
// drive space) come from the operating-system counters in the same call.
//
// Actions go through Windows' own process object: priority class, processor
// affinity (which cores a process may use), stop, and suspend/resume through
// the documented NT calls. Windows' critical processes and Purgeon itself
// are guarded here in the backend — the view hides the buttons too, but the
// guard does not depend on the view.
import { runPSJson } from './shell.js';
import { record } from './history.js';
import { objectResult } from './contracts.js';
import { sys } from './sys.js';

const note = (entry) => record(entry).catch(() => {});

// Processes that must never be ended, suspended or reprioritised: Windows
// cannot run without them, and stopping one blue-screens or signs out.
export const CRITICAL_NAMES = new Set([
  'system', 'registry', 'smss', 'csrss', 'wininit', 'winlogon', 'services',
  'lsass', 'svchost', 'fontdrvhost', 'dwm', 'memcompression', 'secure system',
  'system interrupts', 'idle',
]);

export function guardReason(p) {
  if (!p || !Number.isInteger(p.pid) || p.pid < 0) return 'That process is not running any more.';
  if (p.pid === 0 || p.pid === 4) return 'That is a core Windows process and cannot be changed.';
  const name = String(p.name || '').toLowerCase().replace(/\.exe$/, '');
  if (CRITICAL_NAMES.has(name)) return `${p.name} is one of Windows' critical processes and cannot be changed.`;
  if (name === 'purgeon' || p.pid === sys.info?.pid) return 'That is Purgeon itself.';
  return null;
}

export const PRIORITIES = ['Idle', 'BelowNormal', 'Normal', 'AboveNormal', 'High', 'Realtime'];
// Realtime is deliberately not offered: it can starve the mouse and keyboard.
export const SETTABLE_PRIORITIES = PRIORITIES.filter(p => p !== 'Realtime');

// Percentage of one processor core each process used between two samples.
// Returns a Map pid -> percent of TOTAL processor capacity (0..100).
export function cpuPercents(previous, current, elapsedMs, cores) {
  const out = new Map();
  if (!previous || !(elapsedMs > 0) || !(cores > 0)) return out;
  const before = new Map(previous.map(p => [p.pid, p.cpuSeconds]));
  for (const p of current) {
    const was = before.get(p.pid);
    if (was === undefined || p.cpuSeconds < was) { out.set(p.pid, 0); continue; }
    const pct = ((p.cpuSeconds - was) / (elapsedMs / 1000) / cores) * 100;
    out.set(p.pid, Math.min(100, Math.round(pct * 10) / 10));
  }
  return out;
}

// Resource alerts with a small dead band so a value hovering on the line
// does not flicker: an alert fires at the threshold and clears 2 points
// (or 1 GB) below it. Pure; `active` is the set firing after the last check.
export function alertStates(totals, thresholds, active) {
  const next = new Set(active);
  const t = thresholds || {};
  const check = (key, value, limit, clearAt) => {
    if (limit === null || limit === undefined || !(limit > 0)) { next.delete(key); return; }
    if (value >= limit) next.add(key);
    else if (value <= clearAt) next.delete(key);
  };
  check('cpu', totals.cpuPct, t.cpu, (t.cpu || 0) - 2);
  check('mem', totals.memPct, t.mem, (t.mem || 0) - 2);
  // Disk is watched the other way: free space BELOW the limit is the problem.
  const gb = t.diskFreeGB;
  if (gb === null || gb === undefined || !(gb > 0)) next.delete('disk');
  else if (totals.systemFreeGB < gb) next.add('disk');
  else if (totals.systemFreeGB >= gb + 1) next.delete('disk');
  return next;
}

export function alertText(key, totals, thresholds) {
  if (key === 'cpu') return `The processor has been over ${thresholds.cpu}% busy.`;
  if (key === 'mem') return `Memory is over ${thresholds.mem}% full — closing something will help.`;
  if (key === 'disk') return `Drive ${totals.systemDrive} has under ${thresholds.diskFreeGB} GB free.`;
  return '';
}

export function affinityMask(cores) {
  let mask = 0n;
  for (const c of cores) if (Number.isInteger(c) && c >= 0 && c < 64) mask |= 1n << BigInt(c);
  return mask;
}

let previous = null; // { at, processes: [{pid, cpuSeconds}] }
let suspendedByUs = new Map(); // PID -> verified creation time

const SAMPLE_PS = `
$ErrorActionPreference = 'SilentlyContinue'
$os = Get-CimInstance Win32_OperatingSystem
$cores = (Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors
$cpu = (Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'").PercentProcessorTime
$drive = [System.IO.DriveInfo]::new($env:SystemDrive + '\\')
$procs = Get-Process | ForEach-Object {
  $sus = $false
  try { $sus = $_.Threads.Count -gt 0 -and ($_.Threads | Where-Object { $_.ThreadState -ne 'Wait' -or $_.WaitReason -ne 'Suspended' }).Count -eq 0 } catch {}
  [pscustomobject]@{
    pid = $_.Id; name = $_.ProcessName; cpuSeconds = if ($_.CPU) { $_.CPU } else { 0 }
    memBytes = $_.WorkingSet64; priority = "$($_.PriorityClass)"; threads = $_.Threads.Count
    path = try { $_.Path } catch { $null }; suspended = $sus
    creationTime = try { $_.StartTime.ToFileTimeUtc().ToString() } catch { '' }
  }
}
[pscustomobject]@{
  totals = [pscustomobject]@{
    cpuPct = [int]$cpu; cores = [int]$cores
    memTotalGB = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
    memFreeGB = [math]::Round($os.FreePhysicalMemory / 1MB, 1)
    systemDrive = $env:SystemDrive; systemFreeGB = [math]::Round($drive.AvailableFreeSpace / 1GB, 1)
    systemTotalGB = [math]::Round($drive.TotalSize / 1GB, 1)
  }
  processes = @($procs)
} | ConvertTo-Json -Compress -Depth 4`;

// One sample: totals plus every process with its CPU percentage since the
// previous call (0 on the first call). Sorted busiest first.
export async function sample() {
  const raw = objectResult(await runPSJson(SAMPLE_PS), ['totals', 'processes']);
  if (!Array.isArray(raw.processes) || !raw.totals || !(raw.totals.cores > 0)) throw new Error('Invalid process sample');
  const now = Date.now();
  const cores = raw?.totals?.cores || 1;
  let pcts = new Map();
  if (previous) pcts = cpuPercents(previous.processes, raw.processes, now - previous.at, cores);
  previous = { at: now, processes: raw.processes.map(p => ({ pid: p.pid, creationTime: p.creationTime, cpuSeconds: p.cpuSeconds })) };
  const totals = {
    ...raw.totals,
    memUsedGB: Math.round((raw.totals.memTotalGB - raw.totals.memFreeGB) * 10) / 10,
    memPct: raw.totals.memTotalGB > 0 ? Math.round(((raw.totals.memTotalGB - raw.totals.memFreeGB) / raw.totals.memTotalGB) * 100) : 0,
    diskPct: raw.totals.systemTotalGB > 0 ? Math.round((raw.totals.systemFreeGB / raw.totals.systemTotalGB) * 100) : 0,
  };
  const processes = raw.processes.map(p => ({
    pid: p.pid, name: p.name, path: p.path || '', creationTime: String(p.creationTime || ''),
    cpuPct: pcts.get(p.pid) || 0,
    memMB: Math.round(p.memBytes / 1048576),
    priority: SETTABLE_PRIORITIES.includes(p.priority) ? p.priority : (p.priority || 'Normal'),
    suspended: !!p.suspended || suspendedByUs.get(p.pid) === p.creationTime,
    guarded: guardReason(p),
  })).sort((a, b) => b.cpuPct - a.cpuPct || b.memMB - a.memMB);
  return { totals, processes };
}

async function nativeAction(pid, identity, action) {
  if (!identity || identity.pid !== pid || !/^\d{12,20}$/.test(identity.creationTime || '')) throw new Error('Process identity is missing. Refresh the process list before acting.');
  if (!sys.prepareProcess || !sys.executeProcess) throw new Error('Native process controls are unavailable');
  const plan = await sys.prepareProcess({ pid, creationTime: identity.creationTime, action });
  return sys.executeProcess(plan.id);
}

export async function end(pid, proc) {
  const why = guardReason(proc || { pid, name: '' });
  if (why) throw new Error(why);
  await nativeAction(pid, proc, { kind: 'end' });
  suspendedByUs.delete(pid);
  note({ type: 'Process', title: `Ended ${proc?.name || 'a process'}`, detail: `Process ${pid} was ended from the Processes view. This cannot be undone.`, undo: null });
  return { ok: true };
}

export async function setPriority(pid, level, proc) {
  if (!SETTABLE_PRIORITIES.includes(level)) throw new Error('Choose one of: ' + SETTABLE_PRIORITIES.join(', ') + '.');
  const why = guardReason(proc || { pid, name: '' });
  if (why) throw new Error(why);
  // The view passes the priority it last saw; that becomes the undo target.
  const result = await nativeAction(pid, proc, { kind: 'priority', level });
  const previous = result.previousPriority || '';
  note({
    type: 'Process', title: `Set ${proc?.name || 'a process'} to ${level} priority`,
    detail: previous ? `It was ${previous} before.` : '',
    undo: previous && SETTABLE_PRIORITIES.includes(previous) ? { channel: 'processes:setPriority', arg: { pid, name: proc?.name || '', creationTime: proc.creationTime, level: previous } } : null,
  });
  return { ok: true };
}

export async function setAffinity(pid, cores, proc) {
  const mask = affinityMask(cores || []);
  if (mask === 0n) throw new Error('Tick at least one processor core.');
  const why = guardReason(proc || { pid, name: '' });
  if (why) throw new Error(why);
  await nativeAction(pid, proc, { kind: 'affinity', mask: mask.toString() });
  note({ type: 'Process', title: `Set which cores ${proc?.name || 'a process'} may use`, detail: `Cores ${cores.join(', ')}.`, undo: null });
  return { ok: true };
}


export async function suspend(pid, proc) {
  const why = guardReason(proc || { pid, name: '' });
  if (why) throw new Error(why);
  await nativeAction(pid, proc, { kind: 'suspend' });
  suspendedByUs.set(pid, proc.creationTime);
  note({ type: 'Process', title: `Suspended ${proc?.name || 'a process'}`, detail: 'Resume it from the Processes view.', undo: { channel: 'processes:resume', arg: { pid, name: proc.name, creationTime: proc.creationTime } } });
  return { ok: true };
}

export async function resume(pid, proc) {
  await nativeAction(pid, proc, { kind: 'resume' });
  suspendedByUs.delete(pid);
  note({ type: 'Process', title: 'Resumed a suspended process', detail: `Process ${pid}.`, undo: null });
  return { ok: true };
}
