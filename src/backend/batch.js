// Batch command execution: run a list of operations from a JSON file, one after another.
// Each operation: { op: '<channel>', arg: {...} }. Results are collected and returned;
// a failure stops the batch and reports which operation failed.
import { sys } from './sys.js';
import * as snapshots from './snapshots.js';
import * as monitor from './monitor.js';
import * as maintenance from './maintenance.js';
import * as autostart from './autostart.js';
import * as schedule from './schedule.js';
import * as restorepoint from './restorepoint.js';
import * as associations from './associations.js';
import * as i18n from './i18n.js';
import * as plugins from './plugins.js';
import * as profiler from './profiler.js';
import * as sync from './sync.js';
import * as backups from './backups.js';
import * as junk from './junk.js';
import * as startup from './startup.js';
import * as debloat from './debloat.js';
import * as trials from './trials.js';
import * as explore from './explore.js';
import * as owners from './owners.js';
import * as winget from './winget.js';
import * as portable from './portable.js';
import { runCommandLine } from './shell.js';

const HANDLERS = {
  snapshot: async (a) => snapshots.take(a.name, a.preset || 'standard'),
  'list-snapshots': async () => snapshots.list(),
  maintenance: async (a) => {
    const s = await (await import('./api.js')).readSettings();
    return maintenance.run(a || s.maintenance || {}, s);
  },
  'autostart': async (a) => autostart.set(a === 'on'),
  'background-scan': async () => schedule.backgroundScan(),
  'restore-point': async (a) => restorepoint.create(a),
  associations: async () => associations.extensions(),
  'associations-for': async (a) => associations.extensionsForProgram(a),
  schedule: async (a) => schedule.apply(a),
  language: async (a) => i18n.setLanguage(a),
  'plugins:list': async () => plugins.list(),
  'plugins:enable': async (a) => plugins.setEnabled(a, true),
  'plugins:disable': async (a) => plugins.setEnabled(a, false),
  'plugins:validate': async () => plugins.validate(),
  profiler: async () => profiler.report(),
  'profiler:baseline': async () => profiler.saveBaseline(),
  'profiler:regressions': async () => profiler.detectRegressions(),
  'sync:status': async () => sync.status(),
  'sync:now': async () => sync.syncNow(),
  'backups:prune': async () => backups.prune({ maxDays: 0, maxMB: 0 }),
  'junk:scan': async () => junk.scan(),
  'startup:list': async () => startup.list(),
  'debloat:list': async () => debloat.list(),
  'orphans:scan': async () => owners.orphans(),
  'winget:available': async () => winget.available(),
  'winget:upgrades': async () => winget.upgrades(),
  'portable:find': async () => {
    const s = await (await import('./api.js')).readSettings();
    return portable.find(s.portableFolders || []);
  },
  run: async (a) => runCommandLine(a),
};

// Run one operation by name. Returns { ok, result } or { ok: false, error }.
async function runOne(op) {
  const fn = HANDLERS[op.op];
  if (!fn) return { ok: false, error: `Unknown operation: ${op.op}` };
  try {
    const result = await fn(op.arg);
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

// Execute all operations in order, stopping at the first failure unless continueOnError.
export async function run(operations, { continueOnError = false } = {}) {
  const results = [];
  for (const op of operations) {
    const result = await runOne(op);
    results.push({ op: op.op, ...result });
    if (!result.ok && !continueOnError) break;
  }
  const failed = results.filter((r) => !r.ok).length;
  return { total: results.length, failed, results };
}
