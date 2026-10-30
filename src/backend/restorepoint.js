// System Restore point integration. Creates named restore points before destructive operations
// and lists existing ones, so the user can roll Windows back to a known-good state.
// Uses PowerShell's CheckPoint-Computer (System Restore API).
import { runPSJson, psq } from './shell.js';

// Create a restore point with a description. Returns { ok, created, sequenceNumber }.
export async function create(description) {
  const label = String(description).slice(0, 200);
  const [result] = await runPSJson(`$ErrorActionPreference = 'Stop'
$before = @(Get-ComputerRestorePoint -ErrorAction SilentlyContinue | Select-Object -ExpandProperty SequenceNumber)
Checkpoint-Computer -Description ${psq(label)} -RestorePointType 'MODIFY_SETTINGS' -WarningAction SilentlyContinue
$new = Get-ComputerRestorePoint -ErrorAction SilentlyContinue | Where-Object { $_.SequenceNumber -notin $before -and $_.Description -eq ${psq(label)} } | Sort-Object SequenceNumber -Descending | Select-Object -First 1
[pscustomobject]@{ ok = [bool]$new; created = if ($new) { [string]$new.CreationTime } else { '' }; sequenceNumber = if ($new) { $new.SequenceNumber } else { 0 }; error = if ($new) { '' } else { 'Windows did not create a new restore point. System Protection may be off or throttled.' } } | ConvertTo-Json -Compress`, { timeout: 180000 });
  return result || { ok: false, error: 'Restore point could not be verified' };
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
