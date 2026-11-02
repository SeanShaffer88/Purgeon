// System Restore management (Tools › System Tools): per-drive restore
// storage, protection on/off, the restore points themselves, and a hand-off
// to Windows' own restore wizard for the roll-back itself.
//
// Honesty notes: Windows gives no programmatic per-drive "protection on"
// state (Microsoft's Enable-ComputerRestore documentation says to use
// Rstrui.exe to see it), so a drive is described by what can be proven —
// whether it has restore storage set up, and how much. Turning protection
// off deletes that drive's restore points; Windows offers no undo for
// that, and neither does Purgeon — the window says so before it happens.
import { sys } from './sys.js';
import { runPS, runPSJson } from './shell.js';
import { record } from './history.js';
import * as restorepoint from './restorepoint.js';

const note = (entry) => record(entry).catch(() => {});
const vss = async (args) => {
  const r = await sys.exec('vssadmin.exe', args);
  if (!r.ok) throw new Error(((r.stderr || r.stdout || 'vssadmin failed').trim().split('\n').find((l) => l.trim()) || 'vssadmin failed').trim());
  return r.stdout || '';
};

// vssadmin list shadowstorage blocks:
//   For volume: (C:)\\?\Volume{guid}\
//   Used Shadow Copy Storage space: 4.56 GB
//   Maximum Shadow Copy Storage space: 10% (23.4 GB)   — or UNBOUNDED
export function parseShadowStorage(text) {
  const out = [];
  let current = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const drive = line.match(/For volume:\s*\(([A-Za-z]):\)/);
    if (drive) {
      current = { drive: `${drive[1].toUpperCase()}:`, used: '', maxText: '', maxPct: null, unbounded: false };
      out.push(current);
      continue;
    }
    if (!current) continue;
    const used = line.match(/Used Shadow Copy Storage space:\s*(.+?)\s*$/);
    if (used) current.used = used[1];
    const max = line.match(/Maximum Shadow Copy Storage space:\s*(.+?)\s*$/);
    if (max) {
      current.maxText = max[1];
      const pct = max[1].match(/^(\d+(?:\.\d+)?)%/);
      if (pct) current.maxPct = Number(pct[1]);
      if (/UNBOUNDED/i.test(max[1])) current.unbounded = true;
    }
  }
  return out;
}

// A restore point's CreationTime (WMI format "20261028143022.123456-300")
// and a shadow copy's InstallDate ("/Date(1793490622000)/" in PowerShell
// JSON, or an ISO string) refer to the same moment; match within 2 s.
export function wmiTimeToMs(value) {
  if (typeof value === 'number') return Number.isFinite(value) && !Number.isNaN(new Date(value).getTime()) ? value : null;
  const s = String(value || '');
  const dot = s.match(/^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/);
  if (dot) return Number(dot[1]);
  const wmi = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+-])(\d{3})$/);
  if (wmi) {
    const [year, month, day, hour, minute, second] = wmi.slice(1, 7).map(Number);
    if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
    const local = new Date(0);
    local.setUTCFullYear(year, month - 1, day);
    local.setUTCHours(hour, minute, second, Number(wmi[7].slice(0, 3)));
    if (local.getUTCFullYear() !== year || local.getUTCMonth() !== month - 1 || local.getUTCDate() !== day) return null;
    return local.getTime() - (wmi[8] === '+' ? 1 : -1) * Number(wmi[9]) * 60000;
  }
  if (/^\d{14}\./.test(s)) return null;
  const iso = Date.parse(s);
  return Number.isNaN(iso) ? null : iso;
}

export function matchShadowId(point, shadows) {
  const when = wmiTimeToMs(point?.CreationTime ?? point?.creationTime);
  if (when === null) return null;
  const matches = [];
  for (const s of shadows || []) {
    const at = wmiTimeToMs(s.InstallDate ?? s.installDate);
    if (at !== null && Math.abs(at - when) <= 2000) matches.push(s.ID ?? s.id ?? null);
  }
  return matches.length === 1 ? matches[0] : null;
}

const DRIVE_RE = /^[A-Za-z]:$/;

export async function state() {
  const [drives, storageText, points] = await Promise.all([
    runPSJson(`[System.IO.DriveInfo]::GetDrives() | Where-Object { $_.DriveType -eq 'Fixed' -and $_.IsReady } | ForEach-Object { [pscustomobject]@{ root = $_.RootDirectory.FullName; total = $_.TotalSize } } | ConvertTo-Json -Compress`).catch(() => []),
    vss(['list', 'shadowstorage']).catch(() => ''),
    typeof sys.restorePoints === 'function' ? sys.restorePoints() : restorepoint.list(),
  ]);
  const storage = parseShadowStorage(storageText);
  const byDrive = Object.fromEntries(storage.map((s) => [s.drive, s]));
  const driveList = (Array.isArray(drives) ? drives : [drives]).filter(Boolean).map((d) => {
    const letter = String(d.root || '').slice(0, 2).toUpperCase();
    const s = byDrive[letter];
    return { drive: letter, total: d.total || 0, hasStorage: !!s, used: s?.used || '', maxText: s?.maxText || '', maxPct: s?.maxPct ?? null, unbounded: !!s?.unbounded };
  });
  const pointList = (Array.isArray(points) ? points : []).map((p) => {
    const created = p.created ?? p.CreationTime ?? '';
    const ms = wmiTimeToMs(created);
    return {
      sequence: p.sequence ?? p.SequenceNumber, description: p.description ?? p.Description ?? '', created,
      createdISO: ms ? new Date(ms).toISOString() : '',
    };
  });
  return { drives: driveList, points: pointList };
}

export async function setProtection(drive, on) {
  if (!DRIVE_RE.test(String(drive || ''))) throw new Error('Pick a drive first.');
  const cmd = on ? 'Enable-ComputerRestore' : 'Disable-ComputerRestore';
  await runPS(`${cmd} -Drive '${drive}\\' -ErrorAction Stop`);
  if (on) {
    // Protection only becomes real once storage exists for the drive;
    // enabling alone leaves some PCs with nowhere to keep points.
    const storage = parseShadowStorage(await vss(['list', 'shadowstorage']).catch(() => ''));
    if (!storage.some((s) => s.drive === drive)) {
      await vss(['resize', 'shadowstorage', `/for=${drive}`, `/on=${drive}`, '/maxsize=10%']);
    }
  }
  note({
    type: 'System Restore', title: `Restore protection turned ${on ? 'on' : 'off'} for ${drive}`,
    detail: on ? 'Windows can now keep restore points for this drive.' : 'Turning protection off deleted this drive\'s restore points. Windows offers no undo for that.',
    undo: null,
  });
  return { ok: true };
}

export async function setMaxPct(drive, pct, previous) {
  if (!DRIVE_RE.test(String(drive || ''))) throw new Error('Pick a drive first.');
  if (!Number.isInteger(pct) || pct < 1 || pct > 100) throw new Error('Storage size must be between 1 and 100 percent of the drive.');
  await vss(['resize', 'shadowstorage', `/for=${drive}`, `/on=${drive}`, `/maxsize=${pct}%`]);
  note({
    type: 'System Restore', title: `Restore storage for ${drive} set to ${pct}% of the drive`,
    detail: 'When restore points need more room than this, the oldest are deleted first.',
    undo: previous ? { channel: 'restore:setMax', arg: { drive, pct: previous.pct, unbounded: previous.unbounded, previous: null } } : null,
  });
  return { ok: true };
}

export async function setMaxUnbounded(drive, previous) {
  if (!DRIVE_RE.test(String(drive || ''))) throw new Error('Pick a drive first.');
  await vss(['resize', 'shadowstorage', `/for=${drive}`, `/on=${drive}`, '/maxsize=UNBOUNDED']);
  note({
    type: 'System Restore', title: `Restore storage for ${drive} set to no limit`,
    detail: 'Restore points may use as much of the drive as they need.',
    undo: previous ? { channel: 'restore:setMax', arg: { drive, pct: previous.pct, unbounded: previous.unbounded, previous: null } } : null,
  });
  return { ok: true };
}

export async function removePoint({ sequence, created, description } = {}) {
  if (!Number.isInteger(sequence) || sequence <= 0 || sequence > 0xffffffff || typeof created !== 'string' || !created || created.length > 128 || typeof description !== 'string' || description.length > 1024) throw new Error('Refresh the restore-point list and select a valid point.');
  if (typeof sys.prepareRestoreRemoval !== 'function' || typeof sys.executeRestoreRemoval !== 'function') throw new Error('Native restore-point deletion is unavailable. Use Windows System Restore settings.');
  const plan = await sys.prepareRestoreRemoval({ sequence, expectedCreationTime: created, expectedDescription: description });
  const result = await sys.executeRestoreRemoval(plan.id);
  if (!result?.ok || result.sequence !== sequence) throw new Error('Restore deletion could not be verified. Inspect its native recovery journal before retrying.');
  note({
    type: 'System Restore', title: `Deleted the restore point "${description || 'Restore point'}"`,
    detail: 'A deleted restore point cannot be brought back.',
    undo: null,
  });
  return result;
}

export async function createPoint(description) {
  const r = await restorepoint.create(description || 'Created from Purgeon');
  if (!r.ok) throw new Error('Windows did not create the restore point. It may be turned off for the system drive, or one was created in the last day — Windows limits how often points can be made.');
  note({ type: 'System Restore', title: `Created the restore point "${description || 'Created from Purgeon'}"`, detail: '', undo: null });
  return r;
}

export async function openRestoreUi() {
  await sys.launch('rstrui.exe', []);
  return { ok: true };
}
