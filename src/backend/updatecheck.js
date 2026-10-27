// Update checker: optionally asks the GitHub API whether a newer Purgeon release exists.
// Off by default; the user must enable it in settings. It never sends data except a standard
// HTTPS request to api.github.com, and it never nags after a dismissal.
import { sys } from './sys.js';
import { runPSJson } from './shell.js';
import { readSettings, writeSettings } from './settings.js';

const REPO = 'SeanShaffer88/Purgeon';
const API = `https://api.github.com/repos/${REPO}/releases/latest`;
const SETTING = 'checkForUpdates';
const LAST_CHECK = 'lastUpdateCheck';

export const settings = async () => {
  const s = await readSettings();
  return { enabled: s[SETTING] === true, lastCheck: s[LAST_CHECK] || '' };
};

export const enable = async (on) => {
  const s = await readSettings();
  await writeSettings({ [SETTING]: on === true });
  return { enabled: on === true };
};

export const check = async () => {
  const s = await readSettings();
  if (s[SETTING] !== true) {
    return { enabled: false, update: null, error: 'Update checking is off.' };
  }
  try {
    const script = `
$r = Invoke-RestMethod -Uri '${API}' -ErrorAction Stop -TimeoutSec 15
[pscustomobject]@{
  tag = [string]$r.tag_name
  name = [string]$r.name
  body = [string]$r.body
  url = [string]$r.html_url
  published = [string]$r.published_at
} | ConvertTo-Json -Compress
`;
    const data = await runPSJson(script);
    const release = Array.isArray(data) ? data[0] : (data || {});
    const latest = String(release.tag ?? '').replace(/^v/, '');
    const current = String(sys.info?.version ?? '0.0.0');
    const update = {
      version: latest,
      name: release.name ?? '',
      body: release.body ?? '',
      url: release.url ?? '',
      published: release.published ?? '',
      newer: compareVersions(latest, current) > 0,
    };
    await writeSettings({ [LAST_CHECK]: new Date().toISOString() });
    return { enabled: true, update };
  } catch (e) {
    return { enabled: true, update: null, error: String(e?.message ?? e) };
  }
};

export function compareVersions(a, b) {
  const pa = String(a ?? '').match(/\d+/g) ?? [];
  const pb = String(b ?? '').match(/\d+/g) ?? [];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = Number(pa[i] ?? 0);
    const y = Number(pb[i] ?? 0);
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
