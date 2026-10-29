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
  if (typeof value === 'number') return value;
  const s = String(value || '');
  const dot = s.match(/\/Date\((-?\d+)\)\//);
  if (dot) return Number(dot[1]);
  const wmi = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{3})/);
  if (wmi) return Date.UTC(+wmi[1], +wmi[2] - 1, +wmi[3], +wmi[4], +wmi[5], +wmi[6], +wmi[7]);
  const iso = Date.parse(s);
  return Number.isNaN(iso) ? null : iso;
}

export function matchShadowId(point, shadows) {
  const when = wmiTimeToMs(point?.CreationTime ?? point?.creationTime);
  if (when === null) return null;
  for (const s of shadows || []) {
    const at = wmiTimeToMs(s.InstallDate ?? s.installDate);
    if (at !== null && Math.abs(at - when) <= 2000) return s.ID ?? s.id ?? null;
  }
  return null;
}

const DRIVE_RE = /^[A-Za-z]:$/;

export async function state() {
  const [drives, storageText, points, shadows] = await Promise.all([
    runPSJson(`[System.IO.DriveInfo]::GetDrives() | Where-Object { $_.DriveType -eq 'Fixed' -and $_.IsReady } | ForEach-Object { [pscustomobject]@{ root = $_.RootDirectory.FullName; total = $_.TotalSize } } | ConvertTo-Json -Compress`).catch(() => []),
    vss(['list', 'shadowstorage']).catch(() => ''),
    restorepoint.list().catch(() => []),
    runPSJson(`Get-CimInstance Win32_ShadowCopy -ErrorAction SilentlyContinue | Where-Object { $_.ClientAccessible } | Select-Object ID, InstallDate | ConvertTo-Json -Compress`).catch(() => []),
  ]);
  const storage = parseShadowStorage(storageText);
  const byDrive = Object.fromEntries(storage.map((s) => [s.drive, s]));
  const driveList = (Array.isArray(drives) ? drives : [drives]).filter(Boolean).map((d) => {
    const letter = String(d.root || '').slice(0, 2).toUpperCase();
    const s = byDrive[letter];
    return { drive: letter, total: d.total || 0, hasStorage: !!s, used: s?.used || '', maxText: s?.maxText || '', maxPct: s?.maxPct ?? null, unbounded: !!s?.unbounded };
  });
  const shadowList = Array.isArray(shadows) ? shadows : [shadows];
  const pointList = (Array.isArray(points) ? points : []).map((p) => {
    const ms = wmiTimeToMs(p.CreationTime);
    return {
      sequence: p.SequenceNumber, description: p.Description || 'Restore point', created: p.CreationTime || '',
      createdISO: ms ? new Date(ms).toISOString() : '',
      shadowId: matchShadowId(p, shadowList.filter(Boolean)),
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

const GUID_RE = /^\{[0-9a-f-]{36}\}$|^[0-9a-f-]{36}$/i;

export async function removePoint(shadowId, description) {
  if (!GUID_RE.test(String(shadowId || ''))) throw new Error('This restore point cannot be matched to its stored copy, so Purgeon cannot delete it on its own. Older points can be removed from the Cleaner, and all of them from Windows\' own System Restore settings.');
  await vss(['delete', 'shadows', `/shadow=${shadowId}`, '/quiet']);
  note({
    type: 'System Restore', title: `Deleted the restore point "${description || 'Restore point'}"`,
    detail: 'A deleted restore point cannot be brought back.',
    undo: null,
  });
  return { ok: true };
}

export async function createPoint(description) {
  const r = await restorepoint.create(description || 'Created from Purgeon');
  if (!r.ok) throw new Error('Windows did not create the restore point. It may be turned off for the system drive, or one was created in the last day — Windows limits how often points can be made.');
  note({ type: 'System Restore', title: `Created the restore point "${description || 'Created from Purgeon'}"`, detail: '', undo: null });
  return r;
}

export async function openRestoreUi() {
  await runPS(`Start-Process "$env:SystemRoot\\System32\\rstrui.exe"`);
  return { ok: true };
}
