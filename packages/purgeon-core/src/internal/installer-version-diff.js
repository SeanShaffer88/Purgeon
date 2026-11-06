import { longKey } from './safety.js';

export const RECORDING_ITEM_LIMIT = 10000;
export const RECORDING_GROUP_LIMIT = 200;
export const RECORDING_TARGET_TEXT_LIMIT = 2 * 1024 * 1024;
const fileKinds = new Set(['dir', 'file']);
const registryKinds = new Set(['key', 'value', 'setvalue']);
const registryAliases = new Map([
  ['hklm', 'hkey_local_machine'], ['hkcu', 'hkey_current_user'], ['hkcr', 'hkey_classes_root'],
  ['hku', 'hkey_users'], ['hkcc', 'hkey_current_config'],
]);
const targetEvidence = [
  ['source', 'Source'], ['evidence', 'Evidence label'], ['confidence', 'Confidence'],
  ['score', 'Score'], ['reason', 'Recorded reason'], ['valueType', 'Recorded value type'],
];
const recordingMetadata = [
  ['name', 'Recording label'], ['stampedProduct', 'Installer product stamp'], ['stampedCompany', 'Installer company stamp'],
  ['stampedVersion', 'Installer version stamp'], ['started', 'Started'], ['finished', 'Finished'], ['changedFiles', 'Changed files count'],
];
const valueKind = (kind) => kind === 'value' || kind === 'setvalue';
const validId = (id) => typeof id === 'string' && id.trim().length > 0 && id.length <= 120;
const targetText = (value) => typeof value === 'string' && value.length <= 32767 && !value.includes('\0');
const knownText = (value) => targetText(value) && value.trim() ? value : null;
const clip = (value, limit) => value && value.length > limit ? value.slice(0, limit) + '…' : value;
const time = (value) => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value))
  ? new Date(value).toISOString() : null;
const evidenceValue = (value) => typeof value === 'string' || Number.isFinite(value) ? value : null;

// Ambiguous session IDs cannot identify a comparison side.
export function recordingIndex(records) {
  const byId = new Map();
  for (const record of records) {
    if (validId(record?.id)) byId.set(record.id, byId.has(record.id) ? null : record);
  }
  return byId;
}

function recordingSummary(record) {
  return {
    name: knownText(record.name), stampedProduct: knownText(record.installerInfo?.product),
    stampedCompany: knownText(record.installerInfo?.company), stampedVersion: knownText(record.installerInfo?.version),
    started: time(record.started), finished: time(record.finished),
    changedFiles: Number.isSafeInteger(record.changedFiles) && record.changedFiles >= 0 ? record.changedFiles : null,
  };
}

const displaySummary = (summary) => ({
  ...summary, name: clip(summary.name, 160), stampedProduct: clip(summary.stampedProduct, 160),
  stampedCompany: clip(summary.stampedCompany, 160), stampedVersion: clip(summary.stampedVersion, 160),
});
export const summarizeRecording = (record) => displaySummary(recordingSummary(record));

function recordingTarget(item) {
  const kind = item?.kind;
  if (!targetText(item?.path) || !item.path.trim()) return null;
  const path = item.path;
  let normalized = path;
  let name = '';
  if (registryKinds.has(kind)) {
    normalized = longKey(path).replace(/^(hklm|hkcu|hkcr|hku|hkcc)(?=\\|$)/, (hive) => registryAliases.get(hive));
    if (valueKind(kind)) {
      name = item.name ?? '';
      if (!targetText(name)) return null;
    }
  } else if (kind === 'service') normalized = path.toLowerCase();
  else if (!fileKinds.has(kind)) return null;
  return { kind, key: JSON.stringify([kind, normalized, name.toLowerCase()]), path, name };
}

function collect(items) {
  const buckets = new Map();
  if (!Array.isArray(items)) return { buckets, missing: true, total: null, examined: 0, unrecognized: 0 };
  const limit = Math.min(items.length, RECORDING_ITEM_LIMIT);
  let examined = 0;
  let unrecognized = 0;
  let textUnits = 0;
  for (; examined < limit; examined++) {
    const item = items[examined];
    textUnits += (typeof item?.path === 'string' ? item.path.length : 0)
      + (valueKind(item?.kind) && typeof item.name === 'string' ? item.name.length : 0);
    if (textUnits > RECORDING_TARGET_TEXT_LIMIT) break;
    const target = recordingTarget(item);
    if (!target) { unrecognized++; continue; }
    const previous = buckets.get(target.key);
    if (previous) previous.count++;
    else buckets.set(target.key, { ...target, count: 1, item });
  }
  return { buckets, missing: false, total: items.length, examined, unrecognized };
}

const displayTarget = (bucket) => bucket ? { path: clip(bucket.path, 1024), name: clip(bucket.name, 256), count: bucket.count } : null;

// The projection contains target labels, counts and evidence field names. Registry
// data, commands, and the underlying recording objects remain outside the result.
export function compareInstallRecordings(a, b) {
  if (!validId(a?.id) || !validId(b?.id) || a.id === b.id) return null;
  const { buckets: left, ...aCoverage } = collect(a.items);
  const { buckets: right, ...bCoverage } = collect(b.items);
  const aSummary = recordingSummary(a);
  const bSummary = recordingSummary(b);
  const groups = { a: { kind: 'a', count: 0, rows: [] }, both: { kind: 'both', count: 0, rows: [] }, b: { kind: 'b', count: 0, rows: [] } };
  const keys = [...new Set([...left.keys(), ...right.keys()])].sort();
  for (const key of keys) {
    const l = left.get(key);
    const r = right.get(key);
    const group = l && r ? groups.both : l ? groups.a : groups.b;
    group.count++;
    if (group.rows.length >= RECORDING_GROUP_LIMIT) continue;
    const duplicates = (l?.count ?? 0) > 1 || (r?.count ?? 0) > 1;
    const differences = l && r && !duplicates
      ? targetEvidence.filter(([field]) => evidenceValue(l.item[field]) !== evidenceValue(r.item[field])).map(([, label]) => label)
      : [];
    group.rows.push({ kind: (l || r).kind, a: displayTarget(l), b: displayTarget(r), duplicates, differences });
  }
  return {
    a: { ...displaySummary(aSummary), ...aCoverage }, b: { ...displaySummary(bSummary), ...bCoverage },
    metadataDifferences: recordingMetadata.filter(([field]) => aSummary[field] !== bSummary[field]).map(([, label]) => label),
    sameVersionStamp: !!aSummary.stampedVersion && aSummary.stampedVersion === bSummary.stampedVersion,
    differentProduct: !!aSummary.stampedProduct && !!bSummary.stampedProduct && aSummary.stampedProduct !== bSummary.stampedProduct,
    groups: Object.values(groups),
  };
}
