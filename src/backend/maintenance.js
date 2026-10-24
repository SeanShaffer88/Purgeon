// Scheduled maintenance: a weekly Windows scheduled task that runs "SweepUninstall --maintenance".
// Each run takes a snapshot, cleans the chosen junk categories (Recycle Bin ones only, never the
// permanent Windows clean-ups), applies the backup limits and writes a short report. It never
// uninstalls anything, and its cleanups are undoable from Change History like any other.
import { sys } from './sys.js';
import * as path from './winpath.js';
import { runPS, runPSJson, psq } from './shell.js';
import * as junk from './junk.js';
import * as snapshots from './snapshots.js';
import * as backups from './backups.js';
import * as history from './history.js';

const TASK_PATH = '\\SweepUninstall\\';
const TASK_NAME = 'Weekly Maintenance';
export const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const DEFAULTS = { enabled: false, day: 'Sunday', time: '10:00', snapshot: true, junk: ['usertemp', 'dumps', 'wer', 'thumbs', 'shaders'] };

let dir = '';
export const setRoot = async (d) => {
  dir = d;
  await sys.makeDir(dir);
};

// The task as Windows has it: { registered, nextRun, lastRun, lastResult }.
export async function status() {
  const [s] = await runPSJson(
    `$t = Get-ScheduledTask -TaskPath ${psq(TASK_PATH)} -TaskName ${psq(TASK_NAME)} -ErrorAction SilentlyContinue
     if (-not $t) { '{"registered":false}'; return }
     $i = $t | Get-ScheduledTaskInfo
     [pscustomobject]@{ registered = $true; nextRun = if ($i.NextRunTime) { $i.NextRunTime.ToUniversalTime().ToString('o') } else { '' }; lastRun = if ($i.LastRunTime -and $i.LastRunTime.Year -gt 2000) { $i.LastRunTime.ToUniversalTime().ToString('o') } else { '' }; lastResult = $i.LastTaskResult } | ConvertTo-Json -Compress`
  ).catch(() => [{ registered: false }]);
  return s || { registered: false };
}

// Creates or removes the weekly task to match the settings.
export async function apply(settings) {
  const m = { ...DEFAULTS, ...settings };
  if (!m.enabled) {
    await runPS(`Unregister-ScheduledTask -TaskPath ${psq(TASK_PATH)} -TaskName ${psq(TASK_NAME)} -Confirm:$false -ErrorAction SilentlyContinue`).catch(() => {});
    return status();
  }
  if (!DAYS.includes(m.day) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(m.time)) throw new Error('Choose a day and a time like 10:00.');
  await runPS(`
    $ErrorActionPreference = 'Stop'
    $action = New-ScheduledTaskAction -Execute ${psq(sys.info.exe)} -Argument '--maintenance'
    $trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek ${m.day} -At ${psq(m.time)}
    $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd -ExecutionTimeLimit (New-TimeSpan -Hours 2)
    Register-ScheduledTask -TaskPath ${psq(TASK_PATH)} -TaskName ${psq(TASK_NAME)} -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'SweepUninstall: weekly snapshot, junk clean-up and backup limits. Nothing is uninstalled.' -Force | Out-Null`);
  return status();
}

const fmt = (b) => (b < 1048576 ? `${(b / 1024).toFixed(0)} KB` : b < 1073741824 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1073741824).toFixed(2)} GB`);

// One maintenance run. `limits` are the backup limits from the settings.
export async function run(settings, limits = {}) {
  const m = { ...DEFAULTS, ...settings };
  const lines = [`SweepUninstall maintenance, ${new Date().toLocaleString()}`, ''];
  if (m.snapshot) {
    const meta = await snapshots.take(`Weekly maintenance ${new Date().toISOString().slice(0, 10)}`, 'quick').catch((e) => ({ error: e.message }));
    lines.push(meta.error ? `Snapshot failed: ${meta.error}` : `Snapshot taken: ${meta.name}`);
  }
  const wanted = (m.junk || []).filter((id) => junk.CATEGORIES.some((c) => c.id === id));
  if (wanted.length) {
    const cats = (await junk.scan()).filter((c) => wanted.includes(c.id) && c.items.length);
    if (cats.length) {
      const bytes = cats.reduce((n, c) => n + c.bytes, 0);
      const title = `Weekly maintenance junk (${cats.map((c) => c.label).join(', ')})`;
      const { backupId, results } = await backups.removeItems({ title, items: junk.cleanupItems(cats) });
      const done = results.filter((r) => r.ok).length;
      lines.push(`Junk files: ${done} of ${results.length} items (about ${fmt(bytes)}) moved to the Recycle Bin.`);
      if (backupId) await history.record({ type: 'Removal', title: `Removed ${done} items: ${title}`, detail: `Backup ${backupId}`, undo: { channel: 'backups:restore', arg: backupId } });
    } else lines.push('Junk files: nothing to clean.');
  }
  const removed = await backups.prune({ maxDays: Number(limits.backupMaxDays) || 0, maxMB: Number(limits.backupMaxMB) || 0 }).catch(() => []);
  if (removed.length) lines.push(`Backup limits: ${removed.length} old backups removed.`);
  const report = path.join(dir, `${new Date().toISOString().slice(0, 10)}.txt`);
  await sys.writeText(report, lines.join('\r\n') + '\r\n');
  await history.record({ type: 'Maintenance', title: 'Weekly maintenance ran', detail: lines.slice(2).join(' ') || 'Nothing to do' });
  return { report, lines };
}
