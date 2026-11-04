// Organization policies: restrictions an administrator sets for every user of this PC in
// HKLM\SOFTWARE\Policies\Purgeon (the usual Windows policy location — a standard user
// cannot change values there). Purgeon only reads them. A policy that is set wins over
// the matching feature no matter what the user picks in the window:
//
//   DisableBatchUninstall (DWORD 1) — the uninstall queue refuses new programs.
//   DisableForceRemove    (DWORD 1) — Force removals are refused.
//   DisableSecureErase    (DWORD 1) — Secure Erase is refused.
//
// Anything unreadable or absent means "no policy", so a locked-down or odd registry can
// never break normal use. Enforcement lives in the operations (src/backend/api.js), not
// in window handlers.
import { runPSJson } from './shell.js';

export const POLICY_KEY = 'HKLM\\SOFTWARE\\Policies\\Purgeon';

const on = (v) => v === 1 || v === '1' || v === true || (typeof v === 'string' && v.trim().toLowerCase() === 'true');

// Pure: raw registry values -> the policy set the rest of the app uses.
export function parsePolicy(values) {
  const v = values || {};
  const pick = (...names) => names.map((n) => v[n]).find((x) => x !== undefined);
  return {
    batchUninstallDisabled: on(pick('DisableBatchUninstall')),
    forceRemoveDisabled: on(pick('DisableForceRemove')),
    secureEraseDisabled: on(pick('DisableSecureErase')),
  };
}

export const NO_POLICY = Object.freeze(parsePolicy({}));

// Pure: one line per active restriction, for the About window and --policy.
export function activeRestrictions(policy) {
  const p = policy || NO_POLICY;
  const out = [];
  if (p.batchUninstallDisabled) out.push('Batch uninstall is disabled by your organization (DisableBatchUninstall).');
  if (p.forceRemoveDisabled) out.push('Force removal is disabled by your organization (DisableForceRemove).');
  if (p.secureEraseDisabled) out.push('Secure Erase is disabled by your organization (DisableSecureErase).');
  return out;
}

export async function readPolicy() {
  try {
    const script = `
$p = Get-ItemProperty -Path 'Registry::HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Purgeon' -ErrorAction Stop
[pscustomobject]@{
  DisableBatchUninstall = $p.DisableBatchUninstall
  DisableForceRemove = $p.DisableForceRemove
  DisableSecureErase = $p.DisableSecureErase
} | ConvertTo-Json -Compress
`;
    const data = await runPSJson(script);
    const values = Array.isArray(data) ? data[0] : (data || {});
    return parsePolicy(values);
  } catch {
    return { ...NO_POLICY };
  }
}

// The refusal an operation returns when a policy blocks it, or null when it may proceed.
export function blockedBy(policy, action) {
  const p = policy || NO_POLICY;
  if (action === 'batch' && p.batchUninstallDisabled) return 'Batch uninstall is disabled by a policy set by your organization (DisableBatchUninstall in HKLM\\SOFTWARE\\Policies\\Purgeon).';
  if (action === 'force' && p.forceRemoveDisabled) return 'Force removal is disabled by a policy set by your organization (DisableForceRemove in HKLM\\SOFTWARE\\Policies\\Purgeon).';
  if (action === 'erase' && p.secureEraseDisabled) return 'Secure Erase is disabled by a policy set by your organization (DisableSecureErase in HKLM\\SOFTWARE\\Policies\\Purgeon).';
  return null;
}
