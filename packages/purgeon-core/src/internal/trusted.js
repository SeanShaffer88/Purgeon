// Trusted publisher allowlist.
// Users add certificate subject names (e.g. "Microsoft Corporation").
// Programs signed by a trusted publisher are excluded from Safe Mode blocks
// and unsigned-program warnings. Stored in settings.json under trustedPublishers.
import { sys } from './sys.js';
import { readSettings, writeSettings } from './settings.js';

const SETTING = 'trustedPublishers';
const MAX_NAME_LEN = 200;

const validateName = (name) => {
  const n = String(name ?? '').trim();
  if (!n) throw new Error('Publisher name is required.');
  if (n.length > MAX_NAME_LEN) throw new Error('Publisher name is too long.');
  return n;
};

export const list = async () => {
  const s = await readSettings();
  return Array.isArray(s.trustedPublishers) ? [...s.trustedPublishers] : [];
};

export const add = async (name) => {
  const n = validateName(name);
  const s = await readSettings();
  const pubs = [...new Set([...(s.trustedPublishers || []), n])];
  await writeSettings({ trustedPublishers: pubs });
  return pubs;
};

export const remove = async (name) => {
  const n = validateName(name);
  const s = await readSettings();
  const pubs = (s.trustedPublishers || []).filter((p) => p.toLowerCase() !== n.toLowerCase());
  await writeSettings({ trustedPublishers: pubs });
  return pubs;
};

export const isTrusted = async (signer) => {
  if (!signer) return null;
  const s = await readSettings();
  const pubs = s.trustedPublishers || [];
  const match = pubs.find((p) => p.toLowerCase() === String(signer).toLowerCase());
  return match ?? null;
};

export const filterInsights = async (insights) => {
  const trusted = await list();
  const lower = new Set(trusted.map((t) => t.toLowerCase()));
  const out = {};
  for (const [key, info] of Object.entries(insights ?? {})) {
    const next = { ...info };
    if (info.signer && lower.has(info.signer.toLowerCase())) next.trusted = true;
    out[key] = next;
  }
  return out;
};
