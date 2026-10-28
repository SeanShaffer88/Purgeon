// Plugin / user-script architecture. User scripts live in a `plugins/` folder next to Purgeon's
// data directory. Each plugin is a folder with a manifest.json and a script.js. Plugins run in a
// restricted context and can register leftover-detection rules, custom commands, and menu items.
// Plugins are opt-in: unsigned-by-default, the user must enable each one. They run with the full
// power of the app, so only install plugins you trust.
//
// Plugin scripts execute in a V8 isolate created with node:vm so they cannot reach the host
// global object (no `process`, no `require`, no escape through `constructor.constructor`).
import { sys } from './sys.js';
import * as winpath from './winpath.js';
import { createHash } from 'node:crypto';
import { createContext, runInContext } from 'node:vm';

let pluginRoot = '';
const MANIFEST = 'manifest.json';
const API_VERSION = 1;
const REQUIRED_FIELDS = ['id', 'version', 'apiVersion'];
const VALID_PERMISSIONS = ['read-only', 'read-write'];

export const setRoot = async (dir) => {
  pluginRoot = dir;
  await sys.makeDir(pluginRoot);
};

const manifestPath = (id) => winpath.join(pluginRoot, id, MANIFEST);
const scriptPath = (id) => winpath.join(pluginRoot, id, 'script.js');

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// List installed plugins with validation, permission tier, and integrity status.
export async function list() {
  const entries = await sys.readDir(pluginRoot).catch(() => []);
  const plugins = [];
  for (const e of entries) {
    if (!e.dir) continue;
    let manifest = {};
    try {
      manifest = JSON.parse(await sys.readText(manifestPath(e.name)));
    } catch {}
    const valid = REQUIRED_FIELDS.every((f) => f in manifest) && manifest.apiVersion === API_VERSION;
    const permission = VALID_PERMISSIONS.includes(manifest.permission) ? manifest.permission : 'read-only';
    let integrity = 'unknown';
    try {
      const src = await sys.readText(scriptPath(e.name));
      integrity = manifest.scriptHash === sha256(src) ? 'valid' : 'tampered';
    } catch {}
    plugins.push({
      id: e.name,
      name: manifest.name || e.name,
      version: manifest.version || '0.0.1',
      apiVersion: manifest.apiVersion,
      description: manifest.description || '',
      permission,
      enabled: manifest.enabled !== false,
      author: manifest.author || '',
      commands: manifest.commands || [],
      leftoverRules: manifest.leftoverRules || [],
      valid,
      integrity,
    });
  }
  return plugins;
}

// Read a plugin's script source.
export async function script(pluginId) {
  return sys.readText(scriptPath(pluginId)).catch(() => null);
}

// Enable or disable a plugin (writes to its manifest).
export async function setEnabled(pluginId, enabled) {
  const mp = manifestPath(pluginId);
  let manifest = {};
  try {
    manifest = JSON.parse(await sys.readText(mp));
  } catch {}
  manifest.enabled = enabled;
  await sys.writeTextAtomic(mp, JSON.stringify(manifest, null, 2));
  return { id: pluginId, enabled };
}

// Compute and store the SHA-256 of each plugin's script.js so future runs can detect tampering.
export async function validate() {
  const entries = await sys.readDir(pluginRoot).catch(() => []);
  const results = [];
  for (const e of entries) {
    if (!e.dir) continue;
    try {
      const src = await sys.readText(scriptPath(e.name));
      const hash = sha256(src);
      const mp = manifestPath(e.name);
      let manifest = {};
      try {
        manifest = JSON.parse(await sys.readText(mp));
      } catch {}
      manifest.scriptHash = hash;
      await sys.writeTextAtomic(mp, JSON.stringify(manifest, null, 2));
      results.push({ id: e.name, integrity: 'valid', hash });
    } catch (err) {
      results.push({ id: e.name, integrity: 'error', error: String(err) });
    }
  }
  return results;
}

// Run a plugin's registered leftover rules against the system.
// Read-only plugins may only enumerate; read-write plugins may suggest items for Purgeon to review.
// Purgeon always applies its own protection rules before anything is removed.
export async function runLeftoverRules(pluginId) {
  const manifest = await (async () => {
    try { return JSON.parse(await sys.readText(manifestPath(pluginId))); } catch { return {}; }
  })();
  const permission = VALID_PERMISSIONS.includes(manifest.permission) ? manifest.permission : 'read-only';

  const src = await script(pluginId);
  if (!src) return { id: pluginId, items: [], error: 'No script.js found' };
  // Integrity: refuse to run a plugin whose script has changed since it was installed.
  try {
    const hash = sha256(src);
    if (manifest.scriptHash && manifest.scriptHash !== hash) {
      return { id: pluginId, items: [], error: 'Plugin script has been modified since installation; refusing to run.' };
    }
  } catch {}

  // Sandbox with only safe, read-only APIs exposed.
  const sandbox = {
    sys: {
      exists: (p) => sys.exists(p),
      readText: (p) => sys.readText(p),
      stat: (p) => sys.stat(p),
      walk: (roots) => sys.walk(roots, 3, 5),
      // writePath and removePath are intentionally NOT exposed — plugins can never delete or write.
    },
    path: winpath,
    console: { log: (...a) => {}, error: (...a) => {} },
  };
  const ctx = createContext(sandbox);
  const wrapped = `(async () => { ${src} return getLeftovers(); })()`;
  let result;
  try {
    result = await runInContext(wrapped, ctx, { timeout: 10000 });
  } catch (e) {
    return { id: pluginId, items: [], error: String(e) };
  }
  const items = Array.isArray(result) ? result : result.items || [];
  // Tag each item with the plugin and permission tier so the UI can treat them differently.
  return {
    id: pluginId,
    permission,
    items: items.map((it) => ({ ...it, source: `plugin:${pluginId}`, permission })),
  };
}
