// Browser clean-up: extensions, search engine and home page of Chrome, Edge, Brave and Firefox.
// Extensions that a program added (through the registry, or into Firefox's shared folders) are
// flagged and can be removed with a backup: those are what bundled offers use. Extensions you
// added yourself are listed only; remove them in the browser, which keeps its own records right.
import { sys, env } from './sys.js';
import * as path from './winpath.js';
import { runPSJson } from './shell.js';

const CHROMIUM = [
  { id: 'chrome', name: 'Google Chrome', data: () => path.join(env('LOCALAPPDATA'), 'Google', 'Chrome', 'User Data'), reg: 'Google\\Chrome\\Extensions', process: 'chrome' },
  { id: 'edge', name: 'Microsoft Edge', data: () => path.join(env('LOCALAPPDATA'), 'Microsoft', 'Edge', 'User Data'), reg: 'Microsoft\\Edge\\Extensions', process: 'msedge' },
  { id: 'brave', name: 'Brave', data: () => path.join(env('LOCALAPPDATA'), 'BraveSoftware', 'Brave-Browser', 'User Data'), reg: 'BraveSoftware\\Brave\\Extensions', process: 'brave' },
];

// Extensions registered for a browser in the registry (installed by programs): [{ browser, id, key, update, path }].
const REGISTERED = `
$in = [Console]::In.ReadToEnd() | ConvertFrom-Json
@(foreach ($b in $in) {
  foreach ($root in "HKEY_LOCAL_MACHINE\\SOFTWARE\\$($b.reg)", "HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\$($b.reg)", "HKEY_CURRENT_USER\\Software\\$($b.reg)") {
    foreach ($k in Get-ChildItem -LiteralPath "Registry::$root" -ErrorAction SilentlyContinue) {
      $p = Get-ItemProperty -LiteralPath $k.PSPath -ErrorAction SilentlyContinue
      [pscustomobject]@{ browser = $b.id; id = $k.PSChildName; key = $k.Name; update = [string]$p.update_url; path = [string]$p.path }
    }
  }
}) | ConvertTo-Json -Compress
`;

const readJson = (p) => sys.readText(p).then((t) => JSON.parse(t.replace(/^\uFEFF/, ''))).catch(() => null);

async function extensionName(dir, id, fallback) {
  if (fallback && !/^__MSG_/.test(fallback)) return fallback;
  const versions = (await sys.readDir(path.join(dir, id)).catch(() => [])).filter((e) => e.dir);
  const v = versions[versions.length - 1];
  if (!v) return fallback || id;
  const base = path.join(dir, id, v.name);
  const m = await readJson(path.join(base, 'manifest.json'));
  let name = fallback || m?.name || id;
  const msg = String(name).match(/^__MSG_(.+)__$/);
  if (msg) {
    for (const loc of [m?.default_locale, 'en', 'en_US'].filter(Boolean)) {
      const msgs = await readJson(path.join(base, '_locales', loc, 'messages.json'));
      const hit = msgs && Object.entries(msgs).find(([k]) => k.toLowerCase() === msg[1].toLowerCase());
      if (hit) return hit[1].message;
    }
  }
  return name;
}

// [{ browser, browserName, profile, id, name, version, enabled, addedBy: 'you' | 'program' | 'policy', removable: [items], search, home }]
export async function list() {
  const out = [];
  const settings = [];
  const registered = await runPSJson(REGISTERED, { input: JSON.stringify(CHROMIUM.map(({ id, reg }) => ({ id, reg }))) }).catch(() => []);
  for (const b of CHROMIUM) {
    const data = b.data();
    if (!(await sys.exists(data))) continue;
    const profiles = (await sys.readDir(data).catch(() => [])).filter((e) => e.dir && /^(Default|Profile \d+)$/.test(e.name));
    for (const prof of profiles) {
      const dir = path.join(data, prof.name);
      const prefs = (await readJson(path.join(dir, 'Preferences'))) || {};
      const secure = (await readJson(path.join(dir, 'Secure Preferences'))) || {};
      const ext = { ...(prefs.extensions?.settings || {}), ...(secure.extensions?.settings || {}) };
      const search = prefs.default_search_provider_data?.template_url_data?.short_name || '';
      const home = prefs.homepage_is_newtabpage === false ? prefs.homepage || '' : '';
      settings.push({ browser: b.id, browserName: b.name, profile: prof.name, search, home });
      for (const [id, s] of Object.entries(ext)) {
        if (s.location === 5 || s.location === 10 || id.length !== 32) continue; // built into the browser
        const reg = registered.filter((r) => r.browser === b.id && r.id === id);
        const addedBy = s.location === 3 || s.location === 6 || reg.length ? 'program' : s.location === 2 || s.location === 9 ? 'policy' : 'you';
        out.push({
          browser: b.id,
          browserName: b.name,
          profile: prof.name,
          id,
          name: await extensionName(path.join(dir, 'Extensions'), id, s.manifest?.name),
          version: s.manifest?.version || '',
          enabled: s.state !== 0 && !s.disable_reasons,
          addedBy,
          removable: reg.map((r) => ({ kind: 'key', path: r.key, confidence: 'high', reason: `${b.name} extension added by a program` })),
        });
      }
    }
    // Registered by a program but not (yet) installed in any profile.
    for (const r of registered.filter((x) => x.browser === b.id && !out.some((o) => o.browser === b.id && o.id === x.id))) {
      out.push({ browser: b.id, browserName: b.name, profile: '', id: r.id, name: r.id, version: '', enabled: false, addedBy: 'program', pendingInstall: true, removable: [{ kind: 'key', path: r.key, confidence: 'high', reason: `${b.name} extension added by a program` }] });
    }
  }
  // Firefox: extensions.json in each profile; "app-global" and "app-system-*" add-ons were put in place by a program.
  const ffRoot = env('APPDATA') && path.join(env('APPDATA'), 'Mozilla', 'Firefox', 'Profiles');
  for (const prof of ffRoot ? (await sys.readDir(ffRoot).catch(() => [])).filter((e) => e.dir) : []) {
    const json = await readJson(path.join(ffRoot, prof.name, 'extensions.json'));
    for (const a of json?.addons || []) {
      if (a.type !== 'extension' || a.location === 'app-builtin' || a.location === 'app-system-defaults') continue;
      const byProgram = /^app-(global|system-share|system-local|system-user)$/.test(a.location);
      out.push({
        browser: 'firefox',
        browserName: 'Mozilla Firefox',
        profile: prof.name,
        id: a.id,
        name: a.defaultLocale?.name || a.id,
        version: a.version || '',
        enabled: !!a.active,
        addedBy: byProgram ? 'program' : 'you',
        removable: byProgram && a.path && /^[a-z]:\\/i.test(a.path) ? [{ kind: /\.xpi$/i.test(a.path) ? 'file' : 'dir', path: a.path, confidence: 'high', reason: 'Firefox add-on put in place by a program' }] : [],
      });
    }
  }
  return { extensions: out.sort((x, y) => (x.addedBy === y.addedBy ? x.name.localeCompare(y.name) : x.addedBy === 'program' ? -1 : 1)), settings };
}

// Browsers that are running now; removing an extension waits until they are closed.
export async function running() {
  const rows = await runPSJson(`@(Get-Process chrome, msedge, brave, firefox -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ProcessName -Unique) | ConvertTo-Json -Compress`).catch(() => []);
  return rows.map(String);
}
