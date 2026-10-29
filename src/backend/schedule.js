// Scheduled background monitoring with retry-on-missed and scan-scope filtering.
// Purgeon runs headless on a schedule (idle-time leftover scan, startup-entry watcher)
// through a Windows scheduled task. It never uninstalls anything on its own — it scans,
// reports, and leaves every destructive choice to the user.
import { sys } from './sys.js';
import { runPS, runPSJson, psq } from './shell.js';
import * as winpath from './winpath.js';

const TASK_PATH = '\\Purgeon\\';
const TASK_NAME = 'Background Monitoring';
const OLD_TASK_PATH = '\\SweepUninstall\\';
const removeOld = () =>
  runPS(`Unregister-ScheduledTask -TaskPath ${psq(OLD_TASK_PATH)} -TaskName ${psq(TASK_NAME)} -Confirm:$false -ErrorAction SilentlyContinue`).catch(() => {});

let scheduleRoot = '';

export const setRoot = async (dir) => {
  scheduleRoot = dir;
  await sys.makeDir(scheduleRoot);
};

const stateFile = () => winpath.join(scheduleRoot, 'state.json');

const readState = async () => {
  try {
    return JSON.parse(await sys.readText(stateFile()));
  } catch {
    return { lastRun: '', missed: false, scanCount: 0 };
  }
};

const writeState = async (state) => {
  try {
    await sys.writeTextAtomic(stateFile(), JSON.stringify(state, null, 2));
  } catch {}
};

// Whether the scheduled task is registered, plus persisted state (missed runs, last scan).
export async function status() {
  const [s] = await runPSJson(
    `$t = Get-ScheduledTask -TaskPath ${psq(TASK_PATH)} -TaskName ${psq(TASK_NAME)} -ErrorAction SilentlyContinue\n     if (-not $t) { '{\"registered\":false}'; return }\n     $i = $t | Get-ScheduledTaskInfo\n     [pscustomobject]@{ registered = $true; nextRun = if ($i.NextRunTime) { $i.NextRunTime.ToUniversalTime().ToString('o') } else { '' }; lastRun = if ($i.LastRunTime -and $i.LastRunTime.Year -gt 2000) { $i.LastRunTime.ToUniversalTime().ToString('o') } else { '' }; lastResult = $i.LastTaskResult } | ConvertTo-Json -Compress`
  ).catch(() => [{ registered: false }]);
  const state = await readState();
  return { ...(s || { registered: false }), missed: state.missed, lastScan: state.lastRun, scanCount: state.scanCount };
}

// Create or remove the scheduled task to match the settings.
// scanScope: 'leftovers' | 'startup' | 'both' — what the idle scan checks.
// scanLeftovers/checkStartup: legacy booleans, kept for settings compatibility.
export async function apply(settings) {
  const m = {
    enabled: false,
    scanLeftovers: true,
    checkStartup: true,
    scanScope: 'both',
    ...settings,
  };
  await removeOld();
  if (!m.enabled) {
    await runPS(`Unregister-ScheduledTask -TaskPath ${psq(TASK_PATH)} -TaskName ${psq(TASK_NAME)} -Confirm:$false -ErrorAction SilentlyContinue`).catch(() => {});
    return status();
  }
  const trigger = m.checkStartup ? '-AtLogOn' : '-Daily -At 3:00AM';
  await runPS(
    `$ErrorActionPreference = 'Stop'\n$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name\n$action = New-ScheduledTaskAction -Execute ${psq(sys.info.exe)} -Argument '--background-scan'\n$trigger = New-ScheduledTaskTrigger ${trigger}\n$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest\n$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -IdleDuration (New-TimeSpan -Minutes 15) -StartOnlyIfIdle -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)\nRegister-ScheduledTask -TaskPath ${psq(TASK_PATH)} -TaskName ${psq(TASK_NAME)} -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Purgeon background monitoring: scans for leftovers and new startup entries while the PC is idle.' -Force | Out-Null`
  );
  if (!(await status()).registered) throw new Error('Windows did not create the background monitoring task. It needs administrator rights.');
  return status();
}

// Runs once: a headless leftover scan and/or startup check.
// scope overrides the setting: 'leftovers' | 'startup' | 'both'.
// Returns { retried: true } when this run follows a missed scheduled scan.
export async function backgroundScan({ scope = 'both' } = {}) {
  const state = await readState();
  const now = new Date().toISOString();
  const wasMissed = state.missed === true;
  state.missed = false;
  state.lastRun = now;
  state.scanCount = (state.scanCount || 0) + 1;
  await writeState(state);

  const results = { scanned: 0, leftovers: [], startup: [], time: now, retried: wasMissed, scope };
  try {
    if (scope === 'leftovers' || scope === 'both') {
      const owners = await import('./owners.js');
      const orphaned = await owners.orphans().catch(() => []);
      results.leftovers = orphaned;
      results.scanned += orphaned.length;
    }
    if (scope === 'startup' || scope === 'both') {
      const startup = await import('./startup.js');
      const entries = await startup.list().catch(() => []);
      const running = await import('./running.js');
      const trust = await running.newEntries(entries).catch(() => {});
      results.startup = Object.entries(trust || {}).map(([id, reasons]) => ({ id, reasons }));
      results.scanned += results.startup.length;
    }
  } catch (e) {
    results.leftovers = [];
    results.startup = [];
  }

  const history = await import('./history.js');
  await history
    .record({
      type: 'Background scan',
      title: `Background scan${wasMissed ? ' (retry after missed run)' : ''} found ${results.leftovers.length + results.startup.length} items`,
      detail: `Scope: ${results.scope}`,
    })
    .catch(() => {});
  return results;
}

// Mark the last scheduled scan as missed (e.g. PC was asleep/offline when the task fired).
// The next backgroundScan will report itself as a retry.
export async function markMissed() {
  const state = await readState();
  state.missed = true;
  await writeState(state);
}
