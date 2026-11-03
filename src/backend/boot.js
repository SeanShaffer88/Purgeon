// Boot Options use closed native operations and protected native undo records.
// Renderer history is a reference, never authority over BCD paths or originals.
import { sys } from './sys.js';
import { record } from './history.js';
import * as restorepoint from './restorepoint.js';

const id = (value) => typeof value === 'string' && /^[a-f0-9]{32}$/i.test(value);
const invalid = () => new Error('Windows returned an invalid native Boot response. Refresh and review again.');

export async function state() {
  const value = await sys.bootState();
  if (!value || !(value.timeout === null || (Number.isSafeInteger(value.timeout) && value.timeout >= 0 && value.timeout <= 999)) || !['none', 'minimal', 'network', 'other'].includes(value.safeboot) || !Array.isArray(value.entries) || value.entries.some((e) => !e || typeof e.id !== 'string' || typeof e.name !== 'string' || typeof e.isCurrent !== 'boolean' || typeof e.isDefault !== 'boolean')) throw invalid();
  return value;
}

async function change(request, title) {
  const plan = await sys.prepareBoot(request);
  if (!plan || !id(plan.id) || typeof plan.summary !== 'string' || typeof plan.requiresElevation !== 'boolean') throw invalid();
  const result = await sys.executeBoot(plan.id);
  if (!result || result.ok !== true || result.journalId !== plan.id) throw invalid();
  await record({
    type: 'Boot', title,
    detail: 'The native helper checked the current loader and exact settings, recorded the original state, and verified the change. Settings persist across restarts; nothing here restarts the PC. Safe Mode recovery: use Windows Recovery to inspect the correct loader before clearing its safeboot element.',
    undo: request.kind === 'undo' ? null : { channel: 'boot:undo', arg: { journalId: result.journalId } },
  }).catch(() => {});
  return result;
}

export async function setSafeBoot(mode, previous, withRestorePoint) {
  if (!['none', 'minimal', 'network'].includes(mode)) throw new Error('Unknown start mode.');
  if (previous === null) throw new Error('This legacy Boot undo has no native recovery record. Open Boot Options and review the current settings instead.');
  if (withRestorePoint) {
    const point = await restorepoint.create(`Before changing the start mode (${new Date().toLocaleString()})`).catch(() => ({ ok: false }));
    if (!point.ok) throw new Error('The restore point could not be created, so nothing was changed. Review System Protection or explicitly choose to continue without a restore point.');
  }
  return change({ kind: 'safeBoot', mode }, mode === 'none' ? 'Normal startup restored' : `Safe Mode enabled until changed back (${mode === 'network' ? 'with networking' : 'minimal'})`);
}

export async function setTimeout(seconds, previous) {
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 999) throw new Error('The boot menu wait must be between 0 and 999 seconds.');
  if (previous === null) throw new Error('This legacy Boot undo has no native recovery record. Open Boot Options and review the current settings instead.');
  return change({ kind: 'timeout', seconds }, `Boot menu wait set to ${seconds} seconds`);
}

export async function undo({ journalId }) {
  if (!id(journalId)) throw new Error('This Boot change has no valid native recovery record.');
  return change({ kind: 'undo', journalId }, 'Previous Boot setting restored from its native journal');
}
