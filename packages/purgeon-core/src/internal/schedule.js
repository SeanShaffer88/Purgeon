// Scheduled background monitoring with retry-on-missed and scan-scope filtering.
// Purgeon runs headless on a schedule (idle-time leftover scan, startup-entry watcher)
// through a Windows scheduled task. It never uninstalls anything on its own — it scans,
// reports, and leaves every destructive choice to the user.
import { sys } from './sys.js';
import * as tasks from './tasks.js';
import * as winpath from './winpath.js';


let scheduleRoot = '';

export const setRoot = async (dir) => {
  scheduleRoot = dir;
  await sys.makeDir(scheduleRoot);
};

const stateFile = () => winpath.join(scheduleRoot, 'state.json');

const readState = async () => {
  try {
    return JSON.parse(await sys.readText(stateFile()));
  } catch {
    return { lastRun: '', missed: false, scanCount: 0 };
  }
};

const writeState = async (state) => {
  try {
    await sys.writeTextAtomic(stateFile(), JSON.stringify(state, null, 2));
  } catch {}
};

// Whether the scheduled task is registered, plus persisted state (missed runs, last scan).
export async function status() {
  const s = await tasks.ownedStatus('background');
  const state = await readState();
  return { ...(s || { registered: false }), missed: state.missed, lastScan: state.lastRun, scanCount: state.scanCount };
}

// Create or remove the scheduled task to match the settings.
// scanScope: 'leftovers' | 'startup' | 'both' — what the idle scan checks.
// scanLeftovers/checkStartup: legacy booleans, kept for settings compatibility.
export async function apply(settings) {
  const m = {
    enabled: false,
    scanLeftovers: true,
    checkStartup: true,
    scanScope: 'both',
    ...settings,
  };
  await tasks.configureOwned('background', m.enabled, { checkStartup: m.checkStartup });
  return status();
}

// Runs once: a headless leftover scan and/or startup check.
// scope overrides the setting: 'leftovers' | 'startup' | 'both'.
// Returns { retried: true } when this run follows a missed scheduled scan.
export async function backgroundScan({ scope = 'both' } = {}) {
  const state = await readState();
  const now = new Date().toISOString();
  const wasMissed = state.missed === true;
  state.missed = false;
  state.lastRun = now;
  state.scanCount = (state.scanCount || 0) + 1;
  await writeState(state);

  const results = { scanned: 0, leftovers: [], startup: [], time: now, retried: wasMissed, scope };
  try {
    if (scope === 'leftovers' || scope === 'both') {
      const owners = await import('./owners.js');
      const orphaned = await owners.orphans().catch(() => []);
      results.leftovers = orphaned;
      results.scanned += orphaned.length;
    }
    if (scope === 'startup' || scope === 'both') {
      const startup = await import('./startup.js');
      const entries = await startup.list().catch(() => []);
      const running = await import('./running.js');
      const trust = await running.newEntries(entries).catch(() => {});
      results.startup = Object.entries(trust || {}).map(([id, reasons]) => ({ id, reasons }));
      results.scanned += results.startup.length;
    }
  } catch (e) {
    results.leftovers = [];
    results.startup = [];
  }

  const history = await import('./history.js');
  await history
    .record({
      type: 'Background scan',
      title: `Background scan${wasMissed ? ' (retry after missed run)' : ''} found ${results.leftovers.length + results.startup.length} items`,
      detail: `Scope: ${results.scope}`,
    })
    .catch(() => {});
  return results;
}

// Mark the last scheduled scan as missed (e.g. PC was asleep/offline when the task fired).
// The next backgroundScan will report itself as a retry.
export async function markMissed() {
  const state = await readState();
  state.missed = true;
  await writeState(state);
}
