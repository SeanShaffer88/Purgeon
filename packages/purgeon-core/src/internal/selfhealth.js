// Purgeon Health (Tools › System Tools): checks Purgeon's own working parts — its
// settings, data folder, backups, monitoring records, command log and update checker —
// the same way Health Check checks the PC, but for the app itself. Read-only: it
// reports Pass / Warning / Fail with the evidence, and repairs nothing.
import { sys } from './sys.js';
import * as path from './winpath.js';
import { settingsFile, readSettings } from './settings.js';
import * as backups from './backups.js';
import * as monitor from './monitor.js';
import * as updatecheck from './updatecheck.js';
import * as schedule from './schedule.js';
import * as maintenance from './maintenance.js';
import * as log from './log.js';

// Pure: worst-status summary line for the window header and the CLI.
export function summarize(checks) {
  const list = checks || [];
  const fails = list.filter((c) => c.status === 'fail').length;
  const warns = list.filter((c) => c.status === 'warn').length;
  if (fails) return { status: 'fail', text: `${fails} of ${list.length} checks failed — see the lines below.` };
  if (warns) return { status: 'warn', text: `${warns} of ${list.length} checks need a look — everything else is working.` };
  return { status: 'pass', text: `All ${list.length} checks passed — Purgeon is healthy.` };
}

const line = (id, label, status, detail) => ({ id, label, status, detail });

const when = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
};

// Pure: the health line for one of Purgeon's Windows scheduled tasks, from whether
// the setting says it should exist and what Windows reports about it. A task whose
// last run ended in a non-zero result is a warning, not a failure: the task itself
// is in place and ran. `noun` names the feature for the re-register advice.
export function scheduledTaskCheck(id, label, noun, enabled, st) {
  const s = st || {};
  if (enabled && !s.registered) return line(id, label, 'fail', `On in settings, but the Windows task is missing — turn ${noun} off and on again to register it again.`);
  if (!enabled && s.registered) return line(id, label, 'warn', `Off in settings, but the Windows task still exists — turn ${noun} on and off again to remove it.`);
  if (!enabled) return line(id, label, 'pass', 'Off.');
  const ran = s.lastRun ? `Last ran ${when(s.lastRun)}` : 'Has not run yet';
  const failed = !!(s.lastRun && s.lastResult != null && Number(s.lastResult) !== 0);
  const next = s.nextRun ? `; next run ${when(s.nextRun)}` : '';
  if (failed) return line(id, label, 'warn', `${ran}, and that run ended with result ${s.lastResult}${next}.`);
  return line(id, label, 'pass', `${ran}${s.lastRun ? ', and it finished cleanly' : ''}${next}.`);
}

export async function check() {
  const checks = [];

  try {
    const text = await sys.readText(settingsFile());
    JSON.parse(text);
    checks.push(line('settings', 'Settings file', 'pass', 'Readable and valid.'));
  } catch (e) {
    if (String(e?.message ?? e).includes('ENOENT') || !(await sys.exists(settingsFile()).catch(() => false))) {
      checks.push(line('settings', 'Settings file', 'pass', 'Not created yet — the defaults are in use.'));
    } else {
      checks.push(line('settings', 'Settings file', 'warn', 'The settings file could not be read or is damaged; Purgeon quarantines damaged settings and starts from defaults.'));
    }
  }

  try {
    const probe = path.join(sys.info.dataDir, '.health-probe');
    await sys.writeText(probe, 'ok');
    await sys.removePath(probe);
    checks.push(line('data', 'Data folder', 'pass', `${sys.info.dataDir} is writable.`));
  } catch {
    checks.push(line('data', 'Data folder', 'fail', `${sys.info.dataDir} is not writable — backups, snapshots and records cannot be saved.`));
  }

  try {
    const list = await backups.list();
    const damaged = list.filter((b) => b.verified === false || b.damaged).length;
    checks.push(line('backups', 'Removal backups', damaged ? 'warn' : 'pass',
      damaged ? `${list.length} backups kept; ${damaged} could not be verified.` : `${list.length} backups kept and readable.`));
  } catch {
    checks.push(line('backups', 'Removal backups', 'fail', 'The backups folder could not be read.'));
  }

  try {
    const records = await monitor.list();
    checks.push(line('monitor', 'Installation monitoring', 'pass', `${records.length} monitored installations recorded.`));
  } catch {
    checks.push(line('monitor', 'Installation monitoring', 'warn', 'Monitored-installation records could not be read.'));
  }

  try {
    const s = await readSettings();
    const onOff = (v) => (v === true ? 'on' : 'off');
    checks.push(line('monitors', 'Startup & setup monitors', 'pass',
      `Startup monitor ${onOff(s.watchStartupEntries)}, setup monitor ${onOff(s.detectInstallers)} (both off by default; they watch only while Purgeon is running).`));
  } catch {
    checks.push(line('monitors', 'Startup & setup monitors', 'warn', 'The monitor settings could not be read.'));
  }

  try {
    const st = await schedule.status();
    // Background monitoring has no settings entry of its own: the registered task
    // IS the on/off state (the window's toggle registers and removes it).
    const c = scheduledTaskCheck('bgtask', 'Background monitoring task', 'Background Monitoring', !!st.registered, st);
    if (st.registered && st.missed) {
      checks.push(line('bgtask', 'Background monitoring task', 'warn', `${c.detail} A run was missed while the PC was off or busy; it retries on idle.`));
    } else {
      checks.push(c);
    }
  } catch {
    checks.push(line('bgtask', 'Background monitoring task', 'warn', 'The background monitoring task could not be read.'));
  }

  try {
    const s = await readSettings();
    const enabled = (s.maintenance || {}).enabled === true;
    const st = await maintenance.status();
    checks.push(scheduledTaskCheck('mainttask', 'Weekly maintenance task', 'Weekly Maintenance', enabled, st));
  } catch {
    checks.push(line('mainttask', 'Weekly maintenance task', 'warn', 'The weekly maintenance task could not be read.'));
  }

  try {
    const folder = log.folder();
    const entries = folder ? await sys.readDir(folder).catch(() => []) : [];
    checks.push(line('log', 'Command log', entries.length ? 'pass' : 'warn',
      entries.length ? `${entries.filter((e) => e.file).length} daily log files kept (14 days).` : 'No command log files yet — the log starts with the first command.'));
  } catch {
    checks.push(line('log', 'Command log', 'warn', 'The command log folder could not be read.'));
  }

  try {
    const s = await updatecheck.settings();
    if (!s.enabled) {
      checks.push(line('updates', 'Update checker', 'pass', 'Off (its default). Turn it on in Settings if you want Purgeon to watch for its own updates.'));
    } else {
      // On means the endpoint should answer: run the real check and report what it found.
      const r = await updatecheck.check();
      if (r.error) {
        checks.push(line('updates', 'Update checker', 'warn', `On, but the update check could not reach GitHub just now (${r.error}). Updates are verified by SHA-256 before anything runs.`));
      } else if (r.update) {
        checks.push(line('updates', 'Update checker', 'pass', `On and reachable — Purgeon ${r.update.version} is available. Updates are verified by SHA-256 before anything runs.`));
      } else {
        checks.push(line('updates', 'Update checker', 'pass', 'On and reachable — Purgeon is up to date. Updates are verified by SHA-256 before anything runs.'));
      }
    }
  } catch {
    checks.push(line('updates', 'Update checker', 'warn', 'Update-check settings could not be read.'));
  }

  return { checks, summary: summarize(checks) };
}
