// Boot Options (Tools › System Tools): what the next start does — Safe
// Mode once, the boot-menu wait — through Windows' own bcdedit. Reading
// the boot store needs administrator rights, so without them Windows
// refuses and the window shows that plainly.
//
// Safety shape (by design): Safe Mode changes apply to the NEXT start
// only in the sense that the user turns them off here again — bcdedit's
// safeboot flag itself persists, so the window always shows the current
// state and offers the plain "Normal start" choice. A restore point is
// offered before every change, and every change lands in Change History
// with an undo where one exists.
import { sys } from './sys.js';
import { record } from './history.js';
import * as restorepoint from './restorepoint.js';

const note = (entry) => record(entry).catch(() => {});
const bcd = async (args) => {
  const r = await sys.exec('bcdedit.exe', args);
  if (!r.ok) {
    const text = `${r.stderr || ''} ${r.stdout || ''}`;
    if (/access is denied|could not be opened/i.test(text)) {
      throw new Error('Windows needs administrator rights to read or change the boot settings. Use File › Restart as Administrator, then open Boot Options again.');
    }
    throw new Error((text.trim().split('\n').find((l) => l.trim()) || 'bcdedit failed').trim());
  }
  return r.stdout || '';
};

// bcdedit /enum prints blocks separated by a dashed line. Each block has
// "key<padding>value" lines. Parse into { header, fields } blocks.
export function parseBcd(text) {
  // Shape per entry: a header line, a dashed line, then "key   value"
  // lines whose keys start in column 0.
  const blocks = [];
  let current = null;
  let pendingHeader = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (/^-+$/.test(line.trim())) {
      current = { header: pendingHeader || '', fields: {} };
      blocks.push(current);
      pendingHeader = null;
      continue;
    }
    if (!line.trim()) { current = null; continue; }
    const m = line.match(/^(\S+)\s{2,}(.+?)\s*$/);
    if (m && current) { current.fields[m[1].toLowerCase()] = m[2]; continue; }
    if (/^\S/.test(line)) { pendingHeader = line.trim(); current = null; }
  }
  return blocks;
}

const SAFEBOOT_MODES = { minimal: 'Minimal', network: 'Network', alternateshell: 'AlternateShell' };

export function bootState(blocks) {
  const manager = blocks.find((b) => (b.fields.identifier || '').includes('bootmgr'));
  const current = blocks.find((b) => (b.fields.identifier || '').includes('current'))
    || blocks.find((b) => /windows boot loader/i.test(b.header) && (b.fields.description || ''));
  const loaders = blocks.filter((b) => /windows boot loader/i.test(b.header)).map((b) => ({
    id: b.fields.identifier || '',
    name: b.fields.description || 'Windows',
    isCurrent: (b.fields.identifier || '').includes('current'),
    isDefault: manager ? (manager.fields.default || '') === (b.fields.identifier || '') : false,
  }));
  const rawSafe = (current?.fields.safeboot || '').toLowerCase();
  return {
    timeout: manager ? Number.parseInt(manager.fields.timeout || '30', 10) || 0 : null,
    safeboot: rawSafe ? (Object.entries(SAFEBOOT_MODES).find(([, v]) => v.toLowerCase() === rawSafe)?.[0] || 'other') : 'none',
    entries: loaders,
  };
}

export async function state() {
  return bootState(parseBcd(await bcd(['/enum'])));
}

const MODES = ['none', 'minimal', 'network'];

export async function setSafeBoot(mode, previous, withRestorePoint) {
  if (!MODES.includes(mode)) throw new Error('Unknown start mode.');
  let pointNote = '';
  if (withRestorePoint) {
    const r = await restorepoint.create(`Before changing the start mode (${new Date().toLocaleString()})`).catch(() => ({ ok: false }));
    if (!r.ok) throw new Error('The restore point could not be created, so nothing was changed. Windows limits how often restore points can be made (about one a day by default); untick the restore-point box to go ahead without one.');
    pointNote = ' A restore point was created first.';
  }
  if (mode === 'none') await bcd(['/deletevalue', '{current}', 'safeboot']);
  else await bcd(['/set', '{current}', 'safeboot', mode]);
  note({
    type: 'Boot', title: mode === 'none' ? 'Next start is a normal start' : `Next start is Safe Mode (${mode === 'network' ? 'with networking' : 'minimal'})`,
    detail: `Applies when the PC next starts.${pointNote}`,
    undo: previous && MODES.includes(previous) ? { channel: 'boot:setSafeBoot', arg: { mode: previous, previous: null, withRestorePoint: false } } : null,
  });
  return { ok: true };
}

export async function setTimeout(seconds, previous) {
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 999) throw new Error('The boot menu wait must be between 0 and 999 seconds.');
  await bcd(['/timeout', String(seconds)]);
  note({
    type: 'Boot', title: `Boot menu wait set to ${seconds} seconds`,
    detail: 'How long the list of Windows versions waits at start before the default one loads.',
    undo: Number.isInteger(previous) ? { channel: 'boot:setTimeout', arg: { seconds: previous, previous: null } } : null,
  });
  return { ok: true };
}
