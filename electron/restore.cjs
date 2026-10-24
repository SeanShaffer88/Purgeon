// System Restore points before risky changes. Creation is best effort: Windows skips it
// when System Protection is off or a point was made recently (24h by default), and both
// creating and listing points need administrator rights.
const { runPSJson, psq } = require('./shell.cjs');

const TYPES = { uninstall: 'APPLICATION_UNINSTALL', settings: 'MODIFY_SETTINGS' };

async function create(description, kind, isAdmin) {
  if (!isAdmin) return { created: false, reason: 'Restore points need administrator rights. Use File › Restart as Administrator.' };
  const [result] = await runPSJson(`
    $before = @(Get-ComputerRestorePoint -ErrorAction SilentlyContinue).Count
    $w = $null
    try {
      Checkpoint-Computer -Description ${psq(description.slice(0, 250))} -RestorePointType ${TYPES[kind] || TYPES.settings} -WarningVariable w -WarningAction SilentlyContinue -ErrorAction Stop
    } catch {
      [pscustomobject]@{ created = $false; reason = $_.Exception.Message } | ConvertTo-Json -Compress
      return
    }
    $after = @(Get-ComputerRestorePoint -ErrorAction SilentlyContinue).Count
    [pscustomobject]@{ created = ($after -gt $before); reason = (@($w) -join ' ') } | ConvertTo-Json -Compress
  `);
  if (result.created) return { created: true };
  return { created: false, reason: explain(result.reason) };
}

function explain(reason) {
  if (/1440|already been created|past \d+ minutes/i.test(reason)) return 'Windows already made a restore point in the last 24 hours, so it skipped this one.';
  if (/disabled|turned off|service cannot be started|0x80070422/i.test(reason)) return 'System Protection is turned off for the system drive, so no restore point was made.';
  return reason ? `No restore point was made: ${reason}` : 'Windows did not create a restore point.';
}

module.exports = { create, explain };
