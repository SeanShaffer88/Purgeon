// Event Logs use only the closed native operation family. Renderer paths/names
// are display data; only fresh native channel/destination grants authorize work.
import { sys } from './sys.js';
import { record } from './history.js';
const note = (entry) => record(entry).catch(() => {});
const opaque = (value, length = 32) => typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`, 'i').test(value);
const text = (value) => typeof value === 'string' && value.length > 0;
const fail = () => { throw new Error('Windows returned an invalid event-log response. Refresh the log list before retrying.'); };
const tagged = (value, kind) => { if (!value || typeof value !== 'object' || value.kind !== kind) fail(); return value; };
export function channelGuard(name) {
  return String(name || '').trim().toLowerCase() === 'security' ? 'The Security log is view-and-save only. Purgeon never clears it or changes its recording state.' : null;
}
export function shapeChannels(rows) {
  if (!Array.isArray(rows)) fail();
  return rows.map((row) => {
    if (!row || !text(row.name) || ![row.records,row.sizeBytes].every((value) => value === null || Number.isSafeInteger(value) && value >= 0)
      || !(row.enabled === null || typeof row.enabled === 'boolean') || typeof row.guarded !== 'boolean'
      || !(row.channelId === null || opaque(row.channelId)) || ![row.metadataError,row.configError].every((value) => value === null || typeof value === 'string')) fail();
    return { ...row, guarded: row.guarded || !!channelGuard(row.name) };
  }).sort((a,b) => a.name.localeCompare(b.name));
}
export async function channels() {
  return shapeChannels(tagged(await sys.queryOperation({ kind: 'eventLogChannels' }), 'eventLogChannels').channels);
}
async function config(channelId) {
  if (!opaque(channelId)) throw new Error('This event channel is unavailable. Refresh the log list before retrying.');
  const value = tagged(await sys.queryOperation({ kind: 'eventLogConfig', channelId }), 'eventLogConfig').config;
  if (!value || value.channelId !== channelId || !text(value.name) || typeof value.enabled !== 'boolean' || typeof value.guarded !== 'boolean') fail();
  return value;
}
async function execute(request) {
  const plan = await sys.prepareOperation(request);
  if (!plan || !opaque(plan.id) || !text(plan.summary) || typeof plan.requiresElevation !== 'boolean' || typeof plan.recoveryLimits !== 'string') fail();
  const result = tagged(await sys.executeOperation(plan.id), request.kind);
  if (result.ok !== true || !opaque(result.journalId,64)) throw new Error('The event-log operation did not confirm success. Its native recovery journal must be reviewed before retrying.');
  return result;
}
export async function exportLog(channelId) {
  const channel = await config(channelId);
  const destination = await sys.selectResource({ kind: 'eventLogExportDestination', channelId });
  if (destination === null) return null;
  if (!destination || !opaque(destination.id) || !text(destination.displayPath)) fail();
  const result = await execute({ kind: 'eventLogExport', channelId, destinationGrant: destination.id });
  if (!text(result.path)) fail();
  note({ type: 'Event log', title: `Saved a copy of the ${channel.name} log`, detail: result.path, undo: null });
  return result;
}
export async function clearLog(channelId) {
  const channel = await config(channelId);
  if (channel.guarded || channelGuard(channel.name)) throw new Error(channelGuard(channel.name) || 'This event log is protected.');
  const result = await execute({ kind: 'eventLogClear', channelId });
  if (!text(result.backup)) fail();
  note({ type: 'Event log', title: `Cleared the ${channel.name} log`, detail: `Windows saved and cleared the log in one operation. Recovery copy: ${result.backup}`, undo: null });
  return result;
}
export async function setEnabled(channelId, on, expectedCurrentEnabled) {
  if (typeof on !== 'boolean') throw new Error('Choose a recording state.');
  const channel = await config(channelId);
  if (expectedCurrentEnabled !== undefined && channel.enabled !== expectedCurrentEnabled) throw new Error('The event channel changed before undo could be prepared. Refresh and review it.');
  if (channel.guarded || channelGuard(channel.name) || /^(Application|System)$/i.test(channel.name)) throw new Error('Windows does not allow Purgeon to change recording for this built-in log.');
  const result = await execute({ kind: 'eventLogSetEnabled', channelId, enabled: on });
  if (typeof result.previousEnabled !== 'boolean') fail();
  note({ type: 'Event log', title: `${channel.name} log turned ${on ? 'on' : 'off'}`, detail: `Native journal: ${result.journalId}`, undo: { channel: 'logs:undoEnabled', arg: { name: channel.name, on: result.previousEnabled, expectedCurrentEnabled: on, journalId: result.journalId } } });
  return result;
}
export async function undoEnabled({ name, on, expectedCurrentEnabled, journalId }) {
  if (!text(name) || typeof on !== 'boolean' || typeof expectedCurrentEnabled !== 'boolean' || !opaque(journalId,64)) throw new Error('This event-log undo entry is incomplete. Review it before changing the channel.');
  const matches = (await channels()).filter((channel) => channel.name === name);
  if (matches.length !== 1 || !matches[0].channelId || matches[0].configError || matches[0].enabled !== expectedCurrentEnabled) throw new Error('The event channel is unavailable or changed since this action. Refresh and review its current state before undoing.');
  return setEnabled(matches[0].channelId,on,expectedCurrentEnabled);
}
