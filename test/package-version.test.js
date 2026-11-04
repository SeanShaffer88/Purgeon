import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('Windows setup names preserve stable and supported prerelease versions', () => {
  const helper = fileURLToPath(new URL('../scripts/windows-package-tools.ps1', import.meta.url)).replaceAll("'", "''");
  const result = spawnSync('pwsh', ['-NoProfile', '-Command', `
    . '${helper}'
    foreach ($version in @('1.4.3', '1.5.0-alpha.1', '1.5.0-beta.2', '1.5.0-rc.0')) {
      if ((Get-NsisSetupName $version) -cne ('Purgeon_' + $version + '_x64-setup.exe')) { throw 'Version changed' }
    }
    foreach ($version in @('1.5', '1.5.0-alpha.01', '1.5.0-alpha', '1.5.0+build', '1.5.0/invalid')) {
      $rejected = $false
      try { Get-NsisSetupName $version } catch { $rejected = $true }
      if (-not $rejected) { throw "Accepted invalid version: $version" }
    }
  `], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
