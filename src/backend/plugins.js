// Declarative plugins only; legacy JavaScript never executes in the renderer.
import { sys } from './sys.js';
import * as path from './winpath.js';
import { sha256, pluginId } from './contracts.js';
import { isProtected } from './paths.js';
import { readSettings, writeSettings } from './settings.js';
let root = '';
export const setRoot = async (dir) => { root = dir; await sys.makeDir(dir); };
const manifestPath = (id) => path.join(root, pluginId(id), 'manifest.json');
async function read(id) {
  const text = await sys.readText(manifestPath(id));
  if (text.length > 262144) throw new Error('Plugin manifest is too large');
  const m = JSON.parse(text);
  if (m.id !== id || m.apiVersion !== 2 || !Array.isArray(m.leftoverRules) || m.leftoverRules.length > 128) throw new Error('Plugin requires declarative API version 2; executable scripts are unsupported');
  for (const r of m.leftoverRules) {
    if (!r || !['file', 'dir'].includes(r.kind) || typeof r.path !== 'string' || r.path.length > 1024 || isProtected(r.path) || /[\x00-\x1f*?]/.test(r.path)) throw new Error('Plugin contains an unsafe rule');
  }
  return m;
}
const digest = (m) => sha256(JSON.stringify({ id: m.id, apiVersion: m.apiVersion, version: m.version, leftoverRules: m.leftoverRules }));
export async function list() {
  const approvals = (await readSettings()).pluginApprovals || {};
  const out = [];
  for (const e of await sys.readDir(root).catch(() => [])) {
    if (!e.dir) continue;
    try {
      const m = await read(e.name);
      const approved = approvals[m.id] === await digest(m);
      out.push({ ...m, permission: 'read-only', enabled: m.enabled === true && approved, integrity: approved ? 'valid' : 'unapproved', valid: true, commands: [] });
    } catch (e2) { out.push({ id: e.name, name: e.name, enabled: false, valid: false, integrity: 'unsupported', error: String(e2.message || e2), commands: [], leftoverRules: [] }); }
  }
  return out;
}
export const script = async () => null;
export async function setEnabled(id, enabled) {
  const m = await read(pluginId(id));
  const settings = await readSettings();
  const approvals = { ...(settings.pluginApprovals || {}) };
  if (enabled === true) approvals[id] = await digest(m);
  else delete approvals[id];
  await writeSettings({ pluginApprovals: approvals });
  await sys.writeTextAtomic(manifestPath(id), JSON.stringify({ ...m, enabled: enabled === true }, null, 2));
  return { id, enabled: enabled === true };
}
// Validation reports integrity; it never silently approves new content.
export const validate = async () => (await list()).map(({ id, integrity, error }) => ({ id, integrity, error }));
export async function runLeftoverRules(id) {
  try {
    const m = await read(pluginId(id));
    if (m.enabled !== true || (await readSettings()).pluginApprovals?.[id] !== await digest(m)) throw new Error('Plugin is disabled, changed, or unapproved');
    const items = [];
    for (const rule of m.leftoverRules) {
      const st = await sys.stat(rule.path);
      if (st && !!st.dir === (rule.kind === 'dir')) items.push({ kind: rule.kind, path: rule.path, source: `plugin:${id}`, permission: 'read-only', confidence: 'low', score: 35, reason: 'Plugin suggestion — review ownership', seen: st.modified });
    }
    return { id, permission: 'read-only', items };
  } catch (e) { return { id, items: [], error: String(e.message || e) }; }
}
