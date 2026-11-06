import { sys } from './sys.js';

export const SAVED_PLAN_MAX_BYTES = 1024 * 1024;
const MAX_ROWS = 800;
const FORMAT = 'purgeon-cleanup-plan';
const kinds = new Set(['key', 'value', 'createkey', 'setvalue', 'dir', 'file', 'junk', 'service', 'task', 'firewall']);
const outcomes = new Set(['would-change', 'no-change', 'skipped']);
const fields = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === names.length && names.every((name) => Object.hasOwn(value, name));
const text = (value, limit) => typeof value === 'string' && value.length <= limit && !value.includes('\0');
const createdAt = (value) => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const invalid = () => new Error('Invalid or unsupported saved cleanup plan');

function validate(plan) {
  if (!fields(plan, ['format', 'version', 'createdAt', 'title', 'rows']) || plan.format !== FORMAT
    || plan.version !== 1 || !createdAt(plan.createdAt) || !text(plan.title, 512)
    || !Array.isArray(plan.rows) || plan.rows.length > MAX_ROWS
    || !plan.rows.every((row) => fields(row, ['kind', 'path', 'name', 'group', 'outcome', 'detail'])
      && kinds.has(row.kind) && text(row.path, 32767) && row.path.trim()
      && text(row.name, 32767) && text(row.group, 512) && outcomes.has(row.outcome) && text(row.detail, 4096))) throw invalid();
  return plan;
}

function projection(result) {
  if (!result || typeof result.ok !== 'boolean') throw invalid();
  const outcome = !result.ok ? 'skipped' : ['Already gone', 'Already exists'].includes(result.detail) ? 'no-change' : 'would-change';
  return { kind: result.kind, path: result.path, name: result.name ?? '', group: result.program ?? '', outcome, detail: result.detail };
}

export function serializeSavedCleanupPlan({ title, results }) {
  if (!Array.isArray(results) || results.length > MAX_ROWS) throw invalid();
  const value = validate({ format: FORMAT, version: 1, createdAt: new Date().toISOString(), title, rows: results.map(projection) });
  const output = JSON.stringify(value, null, 2) + '\n';
  if (new TextEncoder().encode(output).byteLength > SAVED_PLAN_MAX_BYTES) throw invalid();
  return output;
}

export async function saveCleanupPlan(request) {
  const output = serializeSavedCleanupPlan(request);
  const file = await sys.saveDialog({ title: 'Save Cleanup Plan', defaultPath: 'purgeon-cleanup-plan.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (typeof file !== 'string' || !file) return false;
  await sys.writeTextAtomic(file, output);
  return true;
}

export async function readSavedCleanupPlan(file) {
  if (!file || !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > SAVED_PLAN_MAX_BYTES) throw invalid();
  try {
    const bytes = await file.slice(0, SAVED_PLAN_MAX_BYTES + 1).arrayBuffer();
    if (bytes.byteLength !== file.size || bytes.byteLength > SAVED_PLAN_MAX_BYTES) throw invalid();
    return validate(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  } catch {
    throw invalid();
  }
}

// Keys compare display literals only. Planner inputs come from the current scan.
const identity = (row) => JSON.stringify([row.kind, row.path, row.name ?? '']);
function indexRows(rows) {
  const index = new Map();
  for (const row of rows) {
    const key = identity(row);
    index.set(key, index.has(key) ? null : row);
  }
  return index;
}

export async function reviewSavedCleanupPlan(plan, currentItems, { isAllowed, check }) {
  validate(plan);
  const saved = indexRows(plan.rows);
  const current = indexRows(currentItems);
  const matched = [];
  const review = plan.rows.map((row) => {
    const key = identity(row);
    const item = current.get(key);
    if (saved.get(key) === null || item === null) return { saved: row, status: 'ambiguous' };
    if (!item) return { saved: row, status: 'missing' };
    if (!isAllowed(item)) return { saved: row, status: 'blocked' };
    const comparison = { saved: row, status: 'unavailable' };
    matched.push({ item, comparison, key });
    return comparison;
  });
  if (!matched.length) return review;
  let fresh;
  try {
    const result = await check(matched.map(({ item }) => item));
    if (!Array.isArray(result?.results)) return review;
    fresh = indexRows(result.results);
  } catch {
    return review;
  }
  for (const { key, comparison } of matched) {
    const result = fresh.get(key);
    if (result === null) { comparison.status = 'ambiguous'; continue; }
    if (!result || typeof result.ok !== 'boolean' || !text(result.detail, 4096)) continue;
    const observed = projection(result);
    comparison.current = observed;
    if (observed.outcome === 'skipped') comparison.status = /^(Could not check|No current supported native task identity)/.test(observed.detail)
      ? 'unavailable' : 'blocked';
    else if (observed.detail === 'Already gone') comparison.status = 'missing';
    else {
      const previous = comparison.saved;
      comparison.status = previous.outcome === observed.outcome && previous.group === observed.group && previous.detail === observed.detail
        ? 'unchanged' : 'changed';
    }
  }
  return review;
}
