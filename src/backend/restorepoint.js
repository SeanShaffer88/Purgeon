// System Restore point integration. Creates named restore points before destructive operations
// and lists existing ones, so the user can roll Windows back to a known-good state.
// Uses PowerShell's CheckPoint-Computer (System Restore API).
import { runPS, runPSJson } from './shell.js';

// Create a restore point with a description. Returns { ok, created, sequenceNumber }.
export async function create(description) {
  const safe = String(description).replace(/'/g, "''");
  const out = await runPS(
    `$ErrorActionPreference = 'Stop'\n$r = CheckPoint-Computer -Description '${safe}' -RestorePointType 'MODIFY_SETTINGS'\n[pscustomobject]@{ ok = $true; created = (Get-Date).ToUniversalTime().ToString('o'); sequenceNumber = $r.SequenceNumber } | ConvertTo-Json -Compress`
  );
  try {
    return JSON.parse(out.trim());
  } catch {
    return { ok: false, created: new Date().toISOString(), sequenceNumber: 0, error: String(out) };
  }
}

// List recent system restore points.
export async function list() {
  const script = `
$out = Get-ComputerRestorePoint -ErrorAction SilentlyContinue | Sort-Object SequenceNumber -Descending | Select-Object -First 20 SequenceNumber, Description, CreationTime, RestorePointType | ConvertTo-Json -Compress -Depth 3
if (-not $out) { '[]' }
$out
`;
  return runPSJson(script).catch(() => []);
}
