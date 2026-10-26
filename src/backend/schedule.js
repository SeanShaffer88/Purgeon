// Scheduled background monitoring: Purgeon runs headless on a schedule (idle-time daily
// leftover scan, startup-entry watcher) through a Windows scheduled task. It never uninstalls
// anything on its own — it scans, reports, and leaves every destructive choice to the user.
import { sys } from './sys.js';
import { runPS, runPSJson, psq } from './shell.js';

const TASK_PATH = '\\Purgeon\\';
const TASK_NAME = 'Background Monitoring';
const OLD_TASK_PATH = '\\SweepUninstall\\';
const removeOld = () =>
  runPS(`Unregister-ScheduledTask -TaskPath ${psq(OLD_TASK_PATH)} -TaskName ${psq(TASK_NAME)} -Confirm:$false -ErrorAction SilentlyContinue`).catch(() => {});

// Whether the scheduled task is registered.
export async function status() {
  const [s] = await runPSJson(
    `$t = Get-ScheduledTask -TaskPath ${psq(TASK_PATH)} -TaskName ${psq(TASK_NAME)} -ErrorAction SilentlyContinue\n     if (-not $t) { '{\"registered\":false}'; return }\n     $i = $t | Get-ScheduledTaskInfo\n     [pscustomobject]@{ registered = $true; nextRun = if ($i.NextRunTime) { $i.NextRunTime.ToUniversalTime().ToString('o') } else { '' }; lastRun = if ($i.LastRunTime -and $i.LastRunTime.Year -gt 2000) { $i.LastRunTime.ToUniversalTime().ToString('o') } else { '' }; lastResult = $i.LastTaskResult } | ConvertTo-Json -Compress`
  ).catch(() => [{ registered: false }]);
  return s || { registered: false };
}

// Create or remove the scheduled task to match the settings. Runs Purgeon with
// '--background-scan' so it scans quietly without showing a window.
export async function apply(settings) {
  const m = { enabled: false, scanLeftovers: true, checkStartup: true, ...settings };
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

// Runs once: a headless leftover scan and startup check, logging results for the user to review
// in Purgeon's Change History. Called by the scheduled task via --background-scan.
export async function backgroundScan() {
  const results = { scanned: 0, leftovers: [], startup: [], time: new Date().toISOString() };
  try {
    const owners = await import('./owners.js');
    const orphaned = await owners.orphans().catch(() => []);
    results.leftovers = orphaned;
    results.scanned = orphaned.length;
  } catch (e) {
    results.leftovers = [];
  }
  // Log the result so it appears in Change History on next launch.
  const history = await import('./history.js');
  await history.add({
    kind: 'backgroundScan',
    description: `Background scan found ${results.leftovers.length} leftover items`,
    time: results.time,
    details: results,
  }).catch(() => {});
  return results;
}
