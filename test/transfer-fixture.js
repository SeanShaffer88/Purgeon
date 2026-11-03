export const absent = () => ({ version: 1, exists: false, digest: null, identity: null });
export const state = (kind, n = 1) => ({ version: 1, exists: true, digest: n.toString(16).padStart(64, '0'), identity: ['file', 'dir'].includes(kind) ? { volume: 1, high: 0, low: n } : null });
export const identityKey = ({ kind, path, name }) => JSON.stringify([kind, path.toLowerCase(), name ?? null]);
export function addPlan(record, exportText = () => '') {
  const items = []; let n = 10;
  for (const kind of ['dir', 'file']) for (const path of Array.isArray(record[kind === 'dir' ? 'dirs' : 'files']) ? record[kind === 'dir' ? 'dirs' : 'files'] : []) {
    const receipt = record.replacementReceipts?.find?.((r) => r.target?.toLowerCase() === String(path).toLowerCase());
    items.push({ kind, path, expected: state(kind, n++), goal: receipt ? { version: 1, exists: true, digest: receipt.digest, identity: receipt.identity } : absent(), phase: 'stage', status: 'pending' });
  }
  for (const key of Array.isArray(record.keys) ? record.keys : []) items.push({ kind: 'key', path: key.path, expected: state('key', n++), goal: key.before ? state('key', 2) : absent(), phase: 'clear', status: 'pending' });
  for (const value of Array.isArray(record.values) ? record.values : []) items.push({ kind: 'value', path: value.path, name: value.name, expected: state('value', n++), goal: value.old ? state('value', 2) : absent(), phase: 'value', status: 'pending' });
  for (const [ordinal, item] of items.entries()) {
    item.ordinal = ordinal;
    const key = record.keys?.find?.((entry) => entry.path === item.path);
    const value = record.values?.find?.((entry) => entry.path === item.path && entry.name === item.name);
    const text = item.kind === 'key' && key.before ? exportText(item.path) : item.kind === 'value' ? JSON.stringify(value.old === null ? null : { kind: value.old?.kind, data: value.old?.data }) : null;
    item.evidence = text === null ? null : createHash('sha256').update(text).digest('hex');
  }
  return { ...record, undoPlan: { version: 1, items } };
}
import { createHash } from 'node:crypto';
