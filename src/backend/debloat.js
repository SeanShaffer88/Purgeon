// Safe, reversible Windows debloat tweaks. Each tweak is a set of registry values:
// "enabled" means every value holds its catalog value. Native restore uses its
// authority's first original, or explicitly confirmed catalog defaults. Empty
// created keys remain; legacy renderer JSON cannot authorize elevated restores.
// effect: 'immediate' | 'explorer' (needs an Explorer restart) | 'reboot'
import { sys } from './sys.js';
import * as path from './winpath.js';
import { runPS } from './shell.js';
import * as datadamage from './datadamage.js';

import TWEAKS from './debloat-catalog.json' with { type: 'json' };

const needsAdmin = (t) => t.values.some((v) => /^HKLM\\|^HKCU\\Software\\Policies\\/i.test(v.key));

async function list() {
  if (!sys.debloatStatus) throw new Error('Native Debloat status is unavailable');
  return sys.debloatStatus();
}

// Values as they were before Purgeon first applied each tweak, so turning a tweak off
// puts back exactly what was there (not just the Windows default).
let stateFile = '';
const setRoot = async (dir) => {
  await sys.makeDir(dir);
  stateFile = path.join(dir, 'previous-values.json');
};
let previousWasDamaged = false;
const readPrevious = async () => {
  let text;
  try {
    text = await sys.readText(stateFile);
  } catch {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    // The exact pre-tweak values are damaged and cannot be recovered: keep a
    // copy of the file, record it, and carry on with the documented off
    // behavior (Windows defaults). The Debloat view warns the user via
    // previousDamaged() — this must never be a silent loss.
    previousWasDamaged = true;
    await datadamage.quarantine(stateFile, text).catch(() => {});
    await sys.writeTextAtomic(stateFile, '{}').catch(() => {});
    return {};
  }
};
const previousDamaged = () => previousWasDamaged;
// Legacy originals remain available for inspection only. Native privileged
// execution never imports renderer/user JSON as a machine recovery authority.
async function set(id, enable) {
  if (!TWEAKS.some((item) => item.id === id)) throw new Error('Unknown Debloat tweak');
  if (typeof enable !== 'boolean' || !sys.prepareDebloat || !sys.executeDebloat) throw new Error('Native Debloat controls are unavailable');
  const plan = await sys.prepareDebloat({ tweakId: id, enabled: enable });
  return sys.executeDebloat(plan.id);
}

async function restartExplorer() {
  await runPS(`
    Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 1500
  `);
  await sys.launch('explorer.exe', []);
}
async function recover(request) {
  if (!sys.prepareDebloatRecovery || !sys.executeDebloat) throw new Error('Native Debloat recovery is unavailable');
  const plan = await sys.prepareDebloatRecovery(request);
  return sys.executeDebloat(plan.id);
}

export { setRoot, list, set, recover, restartExplorer, TWEAKS, needsAdmin, previousDamaged, readPrevious };
