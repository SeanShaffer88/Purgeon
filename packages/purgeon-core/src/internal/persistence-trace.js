import { sys } from './sys.js';
import { list as history } from './history.js';

const runSources = new Set(['hkcu-run', 'hklm-run', 'hklm-run32']);
const statuses = new Set(['matches', 'noMatch', 'disabled', 'denied', 'unsupported', 'partial', 'unavailable']);
const taskActions = new Set(['registered', 'updated', 'deleted', 'disabled']);
const empty = (status) => ({ status, lookbackDays: 7, events: [] });
const label = (value) => typeof value === 'string' && value.length <= 1024 && value.length > 0 && !value.includes('\0') ? value : null;
const validTime = (value) => Number.isSafeInteger(value) && value > 0 && value <= 8.64e15;

function projected(result, kind) {
  if (!statuses.has(result?.status) || result.lookbackDays !== 7 || !Array.isArray(result.events) || result.events.length > 24) return empty('unavailable');
  if (!['matches', 'partial'].includes(result.status)) return empty(result.events.length ? 'unavailable' : result.status);
  const seen = new Set();
  const events = [];
  for (const row of result.events) {
    if (!row || typeof row.recordId !== 'string' || !/^[1-9]\d{0,19}$/.test(row.recordId) || !validTime(row.atMs)
      || !(kind === 'run' ? row.action === 'created' : taskActions.has(row.action)) || seen.has(row.recordId)) continue;
    seen.add(row.recordId);
    const evidence = { recordId: row.recordId, atMs: row.atMs, action: row.action };
    if (kind === 'run') {
      evidence.writerProcess = label(row.writerProcess);
      evidence.writerPid = Number.isInteger(row.writerPid) && row.writerPid > 0 && row.writerPid <= 0xffff_ffff ? row.writerPid : null;
    } else evidence.account = label(row.account);
    events.push(evidence);
  }
  const status = events.length < result.events.length || !events.length ? 'partial' : result.status;
  return { ...empty(status), events };
}

async function read(request) {
  if (!sys.persistenceTrace) return empty('unsupported');
  try { return projected(await sys.persistenceTrace(request), request.kind); }
  catch { return empty('unavailable'); }
}

function disableTimes(records, source, name) {
  return records.flatMap((record) => {
    const undo = record.undo;
    const entry = undo?.arg?.entry;
    if (record.undone || record.type !== 'Startup' || undo?.channel !== 'startup:set' || undo.arg?.enable !== true
      || entry?.type !== 'run' || entry.enabled !== false || entry.source !== source || entry.name !== name || entry.id !== source + '|' + name) return [];
    const at = Date.parse(record.time);
    return validTime(at) ? [at] : [];
  });
}

export async function traceStartup(entry) {
  if (entry?.type !== 'run' || !runSources.has(entry.source) || !label(entry.name)) return empty('unsupported');
  const { source, name } = entry;
  const result = await read({ kind: 'run', source, name });
  // Legacy HKCU history carries no account SID. A portable data directory can
  // be opened by more than one user, so it cannot anchor an account-local event.
  if (source === 'hkcu-run' || !result.events.length) return result;
  const times = disableTimes(await history().catch(() => []), source, name);
  for (const event of result.events) {
    const anchor = times.reduce((latest, at) => at < event.atMs && at > latest ? at : latest, 0);
    if (anchor) event.recordedDisableAtMs = anchor;
  }
  return result;
}

export function traceTask(request) {
  if (typeof request?.path !== 'string' || request.path.length > 512 || !/^\\[^\\]/.test(request.path) || request.path.endsWith('\\')) {
    return Promise.resolve(empty('unsupported'));
  }
  return read({ kind: 'task', path: request.path });
}
