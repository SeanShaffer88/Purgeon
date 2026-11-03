// Runtime scheduled-task operations use closed native grants and protected
// journals. Unsupported principals/actions are read-only; recovery stays disabled.
import { sys } from './sys.js';
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

// Legacy display/format helper only. Its text is never registration authority.
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

const id = (value) => typeof value === 'string' && /^[a-f0-9]{32}$/i.test(value);
const invalid = () => new Error('Windows returned an invalid native scheduled-task response. Refresh and review again.');
export async function list() {
  const rows = []; let cursor = null; const seen = new Set();
  do {
    const page = await sys.taskInventory(cursor);
    if (!page || !Array.isArray(page.rows) || page.rows.length > 64 || !(page.nextCursor === null || typeof page.nextCursor === 'string')) throw invalid();
    for (const row of page.rows) {
      if (!row || typeof row.name !== 'string' || typeof row.path !== 'string' || !(row.taskId === null || id(row.taskId)) || !(row.enabled === null || typeof row.enabled === 'boolean')) throw invalid();
      rows.push(row);
    }
    if (rows.length > 4096 || (page.nextCursor !== null && seen.has(page.nextCursor))) throw invalid();
    cursor = page.nextCursor; if (cursor !== null) seen.add(cursor);
  } while (cursor !== null);
  return rows;
}
function taskId(task) { if (!id(task?.taskId)) throw new Error('This task has no current native identity or is read-only. Refresh the task inventory; legacy name/path actions are refused.'); return task.taskId; }
async function change(request, title, onPrepared) {
  const plan = await sys.prepareTask(request);
  if (!plan || !id(plan.id) || typeof plan.summary !== 'string' || typeof plan.requiresElevation !== 'boolean') throw invalid();
  if (onPrepared) await onPrepared(plan.id);
  let result;
  try { result = await sys.executeTask(plan.id); } catch (error) { const failure = error instanceof Error ? error : new Error(String(error)); failure.nativeTaskJournalId = plan.id; throw failure; }
  if (!result || result.ok !== true || result.journalId !== plan.id || typeof result.changed !== 'boolean' || typeof result.settled !== 'boolean' || typeof result.recoverable !== 'boolean') throw invalid();
  if (result.changed) await note({ type: 'Scheduled task', title, detail: result.detail || '', undo: result.recoverable ? { channel: 'tasks:restore', arg: { journalId: result.journalId } } : null });
  return result;
}
export async function setEnabled(task, on) { if (typeof on !== 'boolean') throw new Error('Choose whether the task is enabled.'); return change({ kind: 'setEnabled', taskId: taskId(task), enabled: on }, `Task turned ${on ? 'on' : 'off'} after native review`); }
export const runNow = async (task) => change({ kind: 'run', taskId: taskId(task) }, 'Task start request acknowledged; completion not assumed');
export const stop = async (task) => change({ kind: 'stop', taskId: taskId(task) }, 'Captured task instances stopped');
export async function remove(task, { onPrepared } = {}) { const guard = taskGuard(task); if (guard) throw new Error(guard); return change({ kind: 'remove', taskId: taskId(task) }, 'Disabled task deleted with native definition backup', onPrepared); }
export async function restoreFromBackup(journalId, legacyName) { if (!id(journalId) || legacyName !== undefined) throw new Error('Legacy task XML/name backups require manual review. Select a completed native task journal instead.'); return change({ kind: 'recover', journalId }, 'Task native original restored; registration stays disabled'); }
export async function restoreDeleted(journalId) { if (!id(journalId)) throw new Error('Select a native task deletion journal.'); return change({ kind: 'recoverDeleted', journalId }, 'Deleted task recreated disabled from its private native journal'); }
export async function create({ name, programGrant, program, trigger, time, day }) {
  if (program !== undefined || !id(programGrant)) throw new Error('Choose the native EXE with the program picker; raw program paths are refused.');
  if (!['logon', 'daily', 'weekly'].includes(trigger)) throw new Error('Pick a supported task trigger.');
  const specification = trigger === 'logon' ? { kind: 'logon' } : trigger === 'daily' ? { kind: 'daily', time } : { kind: 'weekly', day, time };
  return change({ kind: 'create', name, programGrant, trigger: specification }, 'Native selected EXE task created disabled; enable separately');
}
export async function pickProgram() { const selected = await sys.selectTaskProgram(); if (selected !== null && (!id(selected?.id) || typeof selected.displayPath !== 'string')) throw invalid(); return selected; }
export async function ownedStatus(role) { const result = await sys.taskOwnedStatus(role); if (!result || typeof result.registered !== 'boolean' || typeof result.enabled !== 'boolean' || result.owned !== true) throw invalid(); return { ...result, exists: result.registered, registered: result.registered && result.enabled }; }
export async function configureOwned(role, enabled, { day = 'Sunday', time = '10:00', checkStartup = true } = {}) {
  if (!['signin', 'maintenance', 'background'].includes(role) || typeof enabled !== 'boolean' || typeof checkStartup !== 'boolean') throw new Error('Invalid owned task setting.');
  for (let step = 0; step < 5; step++) { const result = await change({ kind: 'configureOwned', role, enabled, day, time, checkStartup }, `Purgeon ${role} task changed through the native catalog`); if (result.settled) return ownedStatus(role); }
  throw new Error('Owned task changes did not settle. Review the retained native journals before retrying.');
}
export async function recoveryStatus(journalId) { if (!id(journalId)) throw new Error('Invalid native task journal.'); return sys.taskRecovery(journalId); }
