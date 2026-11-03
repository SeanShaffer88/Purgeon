// Driver inventory/removal use closed native grants and protected package backups.
// Candidate age is a suggestion, never authority to uninstall a device driver.
import { sys } from './sys.js';
import { record } from './history.js';

const DRIVER_STORE = '%SystemRoot%\\System32\\DriverStore\\FileRepository';

// Lists third-party driver packages: [{ name, originalName, inf, date, version, provider, oem, class }].
// Third-party = not Microsoft, not Windows' own in-box drivers.
const validId = (value) => typeof value === 'string' && /^[a-f0-9]{32}$/i.test(value);
const invalid = () => new Error('Windows returned an invalid native driver response. Refresh and review again.');
export async function listDrivers() {
  const rows = await sys.driverInventory();
  if (!Array.isArray(rows) || rows.some((row) => !row || typeof row.PublishedName !== 'string' || !/^oem\d+\.inf$/i.test(row.PublishedName) || typeof row.InfFile !== 'string' || typeof row.Provider !== 'string' || typeof row.Date !== 'string' || typeof row.Version !== 'string' || typeof row.eligible !== 'boolean' || !(row.driverId === null || validId(row.driverId)) || (row.eligible && !validId(row.driverId)))) throw invalid();
  return rows;
}

// Removes a driver package from the driver store using pnputil /delete-driver.
async function change(request) {
  const plan = await sys.prepareDriver(request);
  if (!plan || !validId(plan.id) || typeof plan.summary !== 'string' || typeof plan.requiresElevation !== 'boolean') throw invalid();
  const result = await sys.executeDriver(plan.id);
  const recovery = request.kind === 'recover';
  if (!result || result.ok !== true || result.journalId !== plan.id || result.stagedOnly !== recovery || typeof result.detail !== 'string') throw invalid();
  await record({ type: 'Driver', title: recovery ? 'Verified driver package staged for recovery' : 'Unused driver package removed with verified backup', detail: result.detail, undo: recovery ? null : { channel: 'drivers:recover', arg: { journalId: result.journalId } } }).catch(() => {});
  return result;
}
export async function deleteDriver(driverId) {
  if (!validId(driverId)) throw new Error('Raw INF removal is no longer supported. Refresh the native driver inventory and select its package identity.');
  return change({ kind: 'remove', driverId });
}
export async function recoverDriver(journalId) {
  if (!validId(journalId)) throw new Error('Select a valid native driver recovery journal.');
  return change({ kind: 'recover', journalId });
}
export async function driverRecovery(journalId) {
  if (!validId(journalId)) throw new Error('Select a valid native driver recovery journal.');
  return sys.driverRecovery(journalId);
}

// Groups parsed driver packages by inf file name and returns old duplicates
// (all but the newest version of each inf) as candidates for removal.
// Pure function: easy to test with mock driver data.
export function findOldDriverCandidates(drivers) {
  const byInf = new Map();
  for (const d of drivers) {
    const key = String(d.InfFile || '').toLowerCase();
    if (!key) continue;
    const existing = byInf.get(key);
    if (!existing) {
      byInf.set(key, [d]);
    } else {
      existing.push(d);
      // Sort by date descending so newest is first
      existing.sort((a, b) => {
        const da = new Date(a.Date || 0).getTime();
        const db = new Date(b.Date || 0).getTime();
        return db - da;
      });
    }
  }
  const candidates = [];
  for (const [, list] of byInf) {
    if (list.length > 1) {
      // All but the newest are candidates
      for (let i = 1; i < list.length; i++) {
        candidates.push(list[i]);
      }
    }
  }
  return candidates;
}

// Returns drivers grouped by inf file name, keeping only the newest version of each.
// Old duplicates are candidates for removal.
export async function oldDriverCandidates() {
  const drivers = await listDrivers();
  return findOldDriverCandidates(drivers.filter((row) => row.eligible && validId(row.driverId)));
}

export { DRIVER_STORE };
