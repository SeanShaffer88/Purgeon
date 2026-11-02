// Scheduled Tasks (Tools › System Tools): everything Windows runs on a
// schedule — Purgeon's own maintenance task and all the rest. Windows'
// own tasks (under \Microsoft\) are badged and can be enabled, disabled
// and run, but never deleted from here; deleting anything else first
// saves its definition to Purgeon's task-backups folder, and that saved
// definition is what Change History's undo re-registers.
import * as path from './winpath.js';
import { sys } from './sys.js';
import { runPS, runPSJson } from './shell.js';
import { record } from './history.js';

const note = (entry) => record(entry).catch(() => {});

export const isWindowsTask = (taskPath) => /^\\Microsoft\\/i.test(String(taskPath || ''));

export function taskGuard(task) {
  if (isWindowsTask(task?.path)) return 'That is one of Windows\' own tasks. Purgeon can turn it off or run it, but never delete it.';
  return null;
}

export function shapeTasks(rows, infos) {
  const infoByKey = new Map();
  for (const i of Array.isArray(infos) ? infos : [infos]) {
    if (i && i.TaskName) infoByKey.set(`${i.TaskPath || '\\'}|${i.TaskName}`, i);
  }
  return (Array.isArray(rows) ? rows : [rows])
    .filter((t) => t && t.TaskName)
    .map((t) => {
      const info = infoByKey.get(`${t.TaskPath || '\\'}|${t.TaskName}`) || {};
      return {
        name: String(t.TaskName),
        path: String(t.TaskPath || '\\'),
        state: String(t.State || ''),
        author: String(t.Author || ''),
        lastRun: info.LastRunTime || '',
        nextRun: info.NextRunTime || '',
        lastResult: typeof info.LastTaskResult === 'number' ? info.LastTaskResult : null,
        isWindows: isWindowsTask(t.TaskPath),
      };
    })
    .sort((a, b) => (a.path + a.name).localeCompare(b.path + b.name));
}

const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// A minimal task definition for Register-ScheduledTask: run a program on
// sign-in, daily, or weekly. Built as XML so the trigger shape is exact.
export function taskXml({ name, program, trigger, time, day }) {
  const start = time || '09:00';
  const today = new Date();
  const iso = (d) => d.toISOString().replace(/\.\d+Z$/, '');
  let triggerXml;
  if (trigger === 'logon') {
    triggerXml = '<LogonTrigger><Enabled>true</Enabled></LogonTrigger>';
  } else if (trigger === 'weekly') {
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const d = days.includes(day) ? day : 'Monday';
    triggerXml = `<CalendarTrigger><StartBoundary>${iso(today).slice(0, 11)}${start}:00</StartBoundary><Enabled>true</Enabled><ScheduleByWeek><DaysOfWeek><${d} /></DaysOfWeek><WeeksInterval>1</WeeksInterval></ScheduleByWeek></CalendarTrigger>`;
  } else {
    triggerXml = `<CalendarTrigger><StartBoundary>${iso(today).slice(0, 11)}${start}:00</StartBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger>`;
  }
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>${esc(name)}</Description></RegistrationInfo>
  <Triggers>${triggerXml}</Triggers>
  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><Enabled>true</Enabled></Settings>
  <Actions Context="Author"><Exec><Command>${esc(program)}</Command></Exec></Actions>
</Task>`;
}

const NAME_RE = /^[\w\- .']+$/;

function checkedTask(task) {
  const name = String(task?.name || '');
  const taskPath = String(task?.path || '\\');
  if (!name || !NAME_RE.test(name) || name.includes('..')) throw new Error('That task name does not look right.');
  if (!/^\\[\w\\\- .]*$/.test(taskPath)) throw new Error('That task folder does not look right.');
  return { name, path: taskPath };
}

export async function list() {
  const [result] = await runPSJson(`$tasks = @(Get-ScheduledTask -ErrorAction SilentlyContinue)
$rows = @($tasks | Select-Object TaskName, TaskPath, State, Author)
$infos = @(foreach ($t in $tasks) {
  $i = $t | Get-ScheduledTaskInfo -ErrorAction SilentlyContinue
  [pscustomobject]@{ TaskName = $t.TaskName; TaskPath = $t.TaskPath; LastRunTime = if ($i) { $i.LastRunTime.ToString('o') } else { '' }; NextRunTime = if ($i -and $i.NextRunTime) { $i.NextRunTime.ToString('o') } else { '' }; LastTaskResult = if ($i) { $i.LastTaskResult } else { $null } }
})
[pscustomobject]@{ rows = $rows; infos = $infos } | ConvertTo-Json -Compress -Depth 4`).catch(() => []);
  return shapeTasks(result?.rows || [], result?.infos || []);
}

const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

async function backupXml(task) {
  const dir = path.join(sys.info.dataDir, 'task-backups');
  await sys.makeDir(dir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${task.name.replace(/[\\/:*?"<>|]/g, '_')}-${stamp}.xml`);
  const xml = await runPS(`Export-ScheduledTask -TaskName ${psQuote(task.name)} -TaskPath ${psQuote(task.path)} -ErrorAction Stop`);
  await sys.writeText(file, xml);
  return file;
}

export async function setEnabled(task, on) {
  const t = checkedTask(task);
  await runPS(`${on ? 'Enable' : 'Disable'}-ScheduledTask -TaskName ${psQuote(t.name)} -TaskPath ${psQuote(t.path)} -ErrorAction Stop | Out-Null`);
  note({
    type: 'Scheduled task', title: `${t.path}${t.name} turned ${on ? 'on' : 'off'}`,
    detail: on ? 'The task will run on its schedule again.' : 'The task stays listed but will not run until it is turned back on.',
    undo: { channel: 'tasks:setEnabled', arg: { task: t, on: !on } },
  });
  return { ok: true };
}

export async function runNow(task) {
  const t = checkedTask(task);
  await runPS(`Start-ScheduledTask -TaskName ${psQuote(t.name)} -TaskPath ${psQuote(t.path)} -ErrorAction Stop`);
  note({ type: 'Scheduled task', title: `Ran ${t.path}${t.name} now`, detail: '', undo: null });
  return { ok: true };
}

export async function stop(task) {
  const t = checkedTask(task);
  await runPS(`Stop-ScheduledTask -TaskName ${psQuote(t.name)} -TaskPath ${psQuote(t.path)} -ErrorAction Stop`);
  note({ type: 'Scheduled task', title: `Stopped ${t.path}${t.name}`, detail: '', undo: null });
  return { ok: true };
}

export async function remove(task) {
  const t = checkedTask(task);
  const guard = taskGuard(t);
  if (guard) throw new Error(guard);
  const backup = await backupXml(t);
  await runPS(`Unregister-ScheduledTask -TaskName ${psQuote(t.name)} -TaskPath ${psQuote(t.path)} -Confirm:$false -ErrorAction Stop`);
  note({
    type: 'Scheduled task', title: `Deleted the task ${t.path}${t.name}`,
    detail: `Its definition was saved first: ${backup}. Undo re-registers it from that copy.`,
    undo: { channel: 'tasks:restore', arg: { file: backup, name: t.name } },
  });
  return { ok: true, backup };
}

export async function restoreFromBackup(file, name) {
  if (!file || !/task-backups/.test(file) || !/\.xml$/i.test(file)) throw new Error('That task backup cannot be used.');
  const xml = await sys.readText(file);
  await runPS(`Register-ScheduledTask -TaskName ${psQuote(name)} -Xml ${psQuote(xml)} -Force -ErrorAction Stop | Out-Null`);
  return { ok: true };
}

export async function create({ name, program, trigger, time, day }) {
  const clean = String(name || '').trim();
  if (!clean || !NAME_RE.test(clean)) throw new Error('Give the task a name (letters, numbers, spaces, dashes).');
  if (!program || typeof program !== 'string') throw new Error('Choose the program the task runs.');
  if (!['logon', 'daily', 'weekly'].includes(trigger)) throw new Error('Pick when the task runs.');
  const xml = taskXml({ name: clean, program, trigger, time, day });
  await runPS(`Register-ScheduledTask -TaskName ${psQuote(clean)} -Xml ${psQuote(xml)} -ErrorAction Stop | Out-Null`);
  note({
    type: 'Scheduled task', title: `Created the task ${clean}`,
    detail: `Runs ${program} ${trigger === 'logon' ? 'at sign-in' : trigger === 'daily' ? `daily at ${time || '09:00'}` : `weekly on ${day || 'Monday'} at ${time || '09:00'}`}.`,
    undo: { channel: 'tasks:remove', arg: { task: { name: clean, path: '\\' } } },
  });
  return { ok: true };
}
