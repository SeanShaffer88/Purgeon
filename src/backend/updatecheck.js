// Update checker: optionally asks the GitHub API whether a newer Purgeon release exists.
// Off by default; the user must enable it in settings. It never sends data except a standard
// HTTPS request to api.github.com, and it never nags after a dismissal.
//
// Download-and-install is a separate, explicit action (the button in the dialog, or
// `Purgeon --update install`): it downloads the release's Setup program, refuses to run
// it unless its SHA-256 matches the digest GitHub records for that exact asset, and only
// then launches it. The installer itself closes the running Purgeon (see updateexit.js)
// and offers to relaunch it afterwards. Portable copies are never installed over: their
// whole point is that the user controls the folder, so they get the release link instead.
import { sys, env } from './sys.js';
import { runPS, runPSJson, psq } from './shell.js';
import { readSettings, writeSettings } from './settings.js';
import * as path from './winpath.js';

const REPO = 'SeanShaffer88/Purgeon';
const API = `https://api.github.com/repos/${REPO}/releases/latest`;
const SETTING = 'checkForUpdates';
const LAST_CHECK = 'lastUpdateCheck';
export const SETUP_ASSET = 'Purgeon-Setup-x64.exe';

export const settings = async () => {
  const s = await readSettings();
  return { enabled: s[SETTING] === true, lastCheck: s[LAST_CHECK] || '' };
};

export const enable = async (on) => {
  const s = await readSettings();
  await writeSettings({ [SETTING]: on === true });
  return { enabled: on === true };
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

// GitHub records a SHA-256 digest per release asset ("sha256:<hex>"). Anything that is
// not exactly 64 hex digits is treated as "no digest" — and no digest means no install.
export function normalizeDigest(digest) {
  const hex = String(digest ?? '').replace(/^sha256:/i, '').trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : '';
}

// Picks the one asset that may be downloaded and run: the x64 Setup program, by exact name.
export function pickSetupAsset(assets) {
  const a = (Array.isArray(assets) ? assets : []).find((x) => x?.name === SETUP_ASSET);
  if (!a?.url) return null;
  return { name: a.name, url: String(a.url), size: Number(a.size) || 0, sha256: normalizeDigest(a.digest) };
}

// Builds the update object from a parsed GitHub "latest release" reply.
export function parseRelease(release, current) {
  const r = release || {};
  const latest = String(r.tag ?? '').replace(/^v/, '');
  return {
    version: latest,
    name: r.name ?? '',
    body: r.body ?? '',
    url: r.url ?? '',
    published: r.published ?? '',
    newer: !!latest && compareVersions(latest, current) > 0,
    installer: pickSetupAsset(r.assets),
  };
}

async function fetchLatest() {
  const script = `
$r = Invoke-RestMethod -Uri '${API}' -ErrorAction Stop -TimeoutSec 15
[pscustomobject]@{
  tag = [string]$r.tag_name
  name = [string]$r.name
  body = [string]$r.body
  url = [string]$r.html_url
  published = [string]$r.published_at
  assets = @($r.assets | ForEach-Object { [pscustomobject]@{ name = [string]$_.name; url = [string]$_.browser_download_url; size = [long]$_.size; digest = [string]$_.digest } })
} | ConvertTo-Json -Compress -Depth 4
`;
  const data = await runPSJson(script);
  const release = Array.isArray(data) ? data[0] : (data || {});
  return parseRelease(release, String(sys.info?.version ?? '0.0.0'));
}

export const check = async () => {
  const s = await readSettings();
  const current = String(sys.info?.version ?? '0.0.0');
  if (s[SETTING] !== true) {
    return { enabled: false, current, update: null, error: 'Update checking is off.' };
  }
  try {
    const update = await fetchLatest();
    await writeSettings({ [LAST_CHECK]: new Date().toISOString() });
    return { enabled: true, current, update };
  } catch (e) {
    return { enabled: true, current, update: null, error: String(e?.message ?? e) };
  }
};

// Pure go/no-go decision for an install, so the safety rules are testable without
// downloading anything: a newer release, a real Setup asset, a recorded digest to
// verify against, and an installed (not portable) copy to update.
export function planInstall(update, { portable } = {}) {
  if (portable) return { ok: false, error: 'This is a portable copy, so it is not updated automatically. Download the new portable build from GitHub Releases instead.' };
  if (!update?.newer) return { ok: false, error: 'No newer version is available.' };
  if (!update.installer) return { ok: false, error: 'The latest release has no Windows Setup program to install.' };
  if (!update.installer.sha256) return { ok: false, error: 'GitHub did not record a SHA-256 digest for the Setup program, so it will not be run unverified. Download it from GitHub Releases instead.' };
  return { ok: true, asset: update.installer, version: update.version };
}

// Pure post-download check: right size (when GitHub stated one) and exact digest match.
export function verifyDownload({ size, sha256 }, asset) {
  if (asset.size > 0 && size !== asset.size) return `The download is incomplete (${size} of ${asset.size} bytes). Nothing was run.`;
  if (!sha256 || String(sha256).toLowerCase() !== asset.sha256) return 'The downloaded Setup program does not match the SHA-256 digest GitHub recorded for it. It was deleted and nothing was run.';
  return null;
}

export const downloadAndInstall = async () => {
  const current = String(sys.info?.version ?? '0.0.0');
  let update;
  try {
    update = await fetchLatest();
  } catch (e) {
    return { ok: false, current, error: `Update check failed: ${String(e?.message ?? e)}` };
  }
  const plan = planInstall(update, { portable: sys.info?.portable === true });
  if (!plan.ok) return { ok: false, current, update, error: plan.error };
  const { asset, version } = plan;
  const dir = env('TEMP') || sys.info?.dataDir || '';
  if (!dir) return { ok: false, current, update, error: 'No temporary folder is available for the download.' };
  const file = path.join(dir, `Purgeon-Setup-${version}.exe`);
  try {
    await runPS(`Invoke-WebRequest -Uri ${psq(asset.url)} -OutFile ${psq(file)} -UseBasicParsing -TimeoutSec 600 -ErrorAction Stop`);
    const stat = await sys.stat(file).catch(() => null);
    const hashes = stat ? await sys.sha256Files([file]).catch(() => []) : [];
    const problem = verifyDownload({ size: stat?.size ?? -1, sha256: hashes?.[0] ?? '' }, asset);
    if (problem) {
      await sys.removePath(file).catch(() => {});
      return { ok: false, current, update, error: problem };
    }
    await sys.launch(file, []);
    return { ok: true, current, update, file, version };
  } catch (e) {
    return { ok: false, current, update, error: `Download failed: ${String(e?.message ?? e)}` };
  }
};
