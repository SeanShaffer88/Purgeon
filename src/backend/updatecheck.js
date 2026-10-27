// Update checker: optionally asks the GitHub API whether a newer Purgeon release exists.
// Off by default; the user must enable it in settings. It never sends data except a standard
// HTTPS request to api.github.com, and it never nags after a dismissal.
import { sys } from './sys.js';
import { runPSJson } from './shell.js';
import * as path from './winpath.js';

const REPO = 'SeanShaffer88/Purgeon';
const API = `https://api.github.com/repos/${REPO}/releases/latest`;
const SETTING = 'checkForUpdates';
const LAST_CHECK = 'lastUpdateCheck';

async function readSettings() {
  try {
    const text = await sys.readText(path.join(sys.info.dataDir, 'settings.json'));
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function writeSettings(next) {
  await sys.writeText(path.join(sys.info.dataDir, 'settings.json'), JSON.stringify(next, null, 2));
}

export const settings = async () => {
  const s = await readSettings();
  return { enabled: s[SETTING] === true, lastCheck: s[LAST_CHECK] || '' };
};

export const enable = async (on) => {
  const s = await readSettings();
  await writeSettings({ ...s, [SETTING]: on === true });
  return { enabled: on === true };
};

export const check = async () => {
  const s = await readSettings();
  if (s[SETTING] !== true) return { enabled: false, update: null, error: 'Update checking is off. Turn it on in Settings.' };
  try {
    const script = `
$r = Invoke-RestMethod -Uri '${API}' -ErrorAction Stop
[pscustomobject]@{ tag = [string]$r.tag_name; name = [string]$r.name; body = [string]$r.body; url = [string]$r.html_url; published = [string]$r.published_at } | ConvertTo-Json -Compress
`;
    const data = await runPSJson(script);
    const release = data[0] || {};
    const latest = String(release.tag || '').replace(/^v/, '');
    const current = String(sys.info?.version || '0.8.0');
    const update = {
      version: latest,
      name: release.name || '',
      body: release.body || '',
      url: release.url || '',
      published: release.published || '',
      newer: compareVersions(latest, current) > 0,
    };
    const next = { ...s, [LAST_CHECK]: new Date().toISOString() };
    await writeSettings(next);
    return { enabled: true, update };
  } catch (e) {
    return { enabled: true, update: null, error: String(e?.message || e) };
  }
};

function compareVersions(a, b) {
  const pa = String(a || '').match(/\d+/g) || [];
  const pb = String(b || '').match(/\d+/g) || [];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = Number(pa[i] || 0);
    const y = Number(pb[i] || 0);
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
