// Purgeon Health (Tools › System Tools): checks Purgeon's own working parts — its
// settings, data folder, backups, monitoring records, command log and update checker —
// the same way Health Check checks the PC, but for the app itself. Read-only: it
// reports Pass / Warning / Fail with the evidence, and repairs nothing.
import { sys } from './sys.js';
import * as path from './winpath.js';
import { settingsFile } from './settings.js';
import * as backups from './backups.js';
import * as monitor from './monitor.js';
import * as updatecheck from './updatecheck.js';
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
    const folder = log.folder();
    const entries = folder ? await sys.readDir(folder).catch(() => []) : [];
    checks.push(line('log', 'Command log', entries.length ? 'pass' : 'warn',
      entries.length ? `${entries.filter((e) => e.file).length} daily log files kept (14 days).` : 'No command log files yet — the log starts with the first command.'));
  } catch {
    checks.push(line('log', 'Command log', 'warn', 'The command log folder could not be read.'));
  }

  try {
    const s = await updatecheck.settings();
    checks.push(line('updates', 'Update checker', 'pass',
      s.enabled ? `On — last checked ${s.lastCheck || 'never'}. Updates are verified by SHA-256 before anything runs.` : 'Off (its default). Turn it on in Settings if you want Purgeon to watch for its own updates.'));
  } catch {
    checks.push(line('updates', 'Update checker', 'warn', 'Update-check settings could not be read.'));
  }

  return { checks, summary: summarize(checks) };
}
