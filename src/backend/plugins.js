// Plugin / user-script architecture. User scripts live in a `plugins/` folder next to Purgeon's
// data directory. Each plugin is a folder with a manifest.json and a script.js. Plugins run in a
// restricted context and can register leftover-detection rules, custom commands, and menu items.
// Plugins are opt-in: unsigned-by-default, the user must enable each one. They run with the full
// power of the app, so only install plugins you trust.
import { sys } from './sys.js';
import * as winpath from './winpath.js';

let pluginRoot = '';

export const setRoot = async (dir) => {
  pluginRoot = dir;
  await sys.makeDir(pluginRoot);
};

// The manifest every plugin needs.
const MANIFEST = 'manifest.json';

// List installed plugins with their enabled state.
export async function list() {
  const entries = await sys.readDir(pluginRoot).catch(() => []);
  const plugins = [];
  for (const e of entries) {
    if (!e.dir) continue;
    const manifestPath = winpath.join(pluginRoot, e.name, MANIFEST);
    let manifest = {};
    try {
      manifest = JSON.parse(await sys.readText(manifestPath));
    } catch {}
    plugins.push({
      id: e.name,
      name: manifest.name || e.name,
      version: manifest.version || '0.0.1',
      description: manifest.description || '',
      enabled: manifest.enabled !== false, // enabled by default until explicitly disabled
      author: manifest.author || '',
      commands: manifest.commands || [],
      leftoverRules: manifest.leftoverRules || [],
    });
  }
  return plugins;
}

// Read a plugin's script source.
export async function script(pluginId) {
  return sys.readText(winpath.join(pluginRoot, pluginId, 'script.js')).catch(() => null);
}

// Enable or disable a plugin (writes to its manifest).
export async function setEnabled(pluginId, enabled) {
  const manifestPath = nodePath.join(pluginRoot, pluginId, MANIFEST);
  let manifest = {};
  try {
    manifest = JSON.parse(await sys.readText(manifestPath));
  } catch {}
  manifest.enabled = enabled;
  await sys.writeText(manifestPath, JSON.stringify(manifest, null, 2));
  return { id: pluginId, enabled };
}

// Run a plugin's registered leftover rules against the system. Each rule is a { name, paths, keys }
// declaration; the plugin returns candidate leftovers, Purgeon applies its protection rules before
// anything is removed.
export async function runLeftoverRules(pluginId) {
  const src = await script(pluginId);
  if (!src) return { id: pluginId, items: [], error: 'No script.js found' };
  // Plugin scripts run in a Function sandbox with only safe, read-only APIs exposed.
  const sandbox = {
    sys: {
      exists: (p) => sys.exists(p),
      readText: (p) => sys.readText(p),
      stat: (p) => sys.stat(p),
      walk: (roots) => sys.walk(roots, 3, 5),
    },
    path: winpath,
    console: { log: (...a) => {}, error: (...a) => {} },
  };
  let items = [];
  try {
    const fn = new Function('sys', 'path', 'console', src + '\nreturn getLeftovers();');
    const result = await fn(sandbox.sys, sandbox.path, sandbox.console);
    items = Array.isArray(result) ? result : result.items || [];
  } catch (e) {
    return { id: pluginId, items: [], error: String(e) };
  }
  return { id: pluginId, items };
}
