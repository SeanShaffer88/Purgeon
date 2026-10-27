// Trusted publisher allowlist. Users can add digital-signing certificate subjects (e.g.
// "Microsoft Corporation", "Adobe Inc.") that they trust. Programs signed by a trusted
// publisher are never blocked by Safe Mode and are excluded from unsigned-program warnings.
// Stored in settings.json under trustedPublishers.
import { sys } from './sys.js';
import { readSettings } from './api.js';
import * as path from './winpath.js';

const SETTING = 'trustedPublishers';

export const list = async () => {
  const s = await readSettings();
  return s.trustedPublishers || [];
};

export const add = async (name) => {
  const s = await readSettings();
  const pubs = [...new Set([...(s.trustedPublishers || []), String(name).trim()]).filter(Boolean)];
  await sys.writeText(path.join(sys.info.dataDir, 'settings.json'), JSON.stringify({ ...s, trustedPublishers: pubs }, null, 2));
  return pubs;
};

export const remove = async (name) => {
  const s = await readSettings();
  const pubs = (s.trustedPublishers || []).filter((p) => p.toLowerCase() !== String(name).toLowerCase());
  await sys.writeText(path.join(sys.info.dataDir, 'settings.json'), JSON.stringify({ ...s, trustedPublishers: pubs }, null, 2));
  return pubs;
};

// Check whether a signer is trusted. Returns the publisher name if trusted, null otherwise.
export const isTrusted = async (signer) => {
  if (!signer) return null;
  const s = await readSettings();
  const pubs = s.trustedPublishers || [];
  return pubs.find((p) => p.toLowerCase() === String(signer).toLowerCase()) || null;
};

// Filter a program-insights map: mark entries whose signer is trusted.
export const filterInsights = async (insights) => {
  const trusted = await list();
  const out = {};
  for (const [key, info] of Object.entries(insights)) {
    const next = { ...info };
    if (info.signer && trusted.some((t) => t.toLowerCase() === info.signer.toLowerCase())) {
      next.trusted = true;
    }
    out[key] = next;
  }
  return out;
};
