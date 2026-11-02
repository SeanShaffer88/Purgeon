import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { taskRemovalScript, firewallRemovalScript, firewallRestoreScript } from '../src/backend/backup-scripts.js';
const exec = promisify(execFile);
async function probe(script, prelude) {
  const body = `${prelude}\ntry { & { ${script} }; 'SUCCEEDED' } catch { 'REFUSED ' + $_.Exception.Message }; 'MUTATIONS ' + $script:mutations`;
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(body, 'utf16le').toString('base64')], { windowsHide: true });
  return stdout;
}

test('task export/readback failures never dispatch unregister', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'purgeon-task-script-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const mode of ['export-fail', 'empty', 'invalid-xml', 'write-fail', 'ok']) {
    const target = mode === 'write-fail' ? path.join(dir, 'absent', 'task.xml') : path.join(dir, `${mode}.xml`);
    const prelude = `$script:mutations=0; $script:removed=$false
function Get-ScheduledTask { param($TaskName,$TaskPath); if (-not $script:removed) { [pscustomobject]@{TaskName='Fixture';TaskPath='\\'} } }
function Export-ScheduledTask { param($TaskName,$TaskPath); ${mode === 'export-fail' ? "throw 'export failed'" : mode === 'empty' ? "''" : mode === 'invalid-xml' ? "'<Other />'" : "'<Task />'"} }
function Unregister-ScheduledTask { param($TaskName,$TaskPath,$Confirm); $script:mutations++; $script:removed=$true }`;
    const out = await probe(taskRemovalScript('\\Fixture', target), prelude);
    assert.match(out, mode === 'ok' ? /MUTATIONS 1/ : /MUTATIONS 0/, out);
    assert.match(out, mode === 'ok' ? /SUCCEEDED/ : /REFUSED/, out);
  }
});

const firewallFixture = (mode) => `$script:mutations=0; $script:removed=$false
$script:rule=[pscustomobject]@{ Name='Fixture';DisplayName='Fixture';Direction='Inbound';Action='Allow';Profile='Any';Enabled='True';EdgeTraversalPolicy='${mode === 'edge' ? 'Allow' : 'Block'}' }
function Get-NetFirewallRule { param($Name); if (-not $script:removed) { $script:rule } }
function Get-NetFirewallApplicationFilter { param([Parameter(ValueFromPipeline=$true)]$InputObject); process { [pscustomobject]@{Program='C:\\Fixture.exe';Package='${mode === 'package' ? 'Package.Identity' : 'Any'}'} } }
function Get-NetFirewallPortFilter { param([Parameter(ValueFromPipeline=$true)]$InputObject); process { [pscustomobject]@{Protocol='TCP';LocalPort=@('80');RemotePort=@('Any')} } }
function Get-NetFirewallAddressFilter { param([Parameter(ValueFromPipeline=$true)]$InputObject); process { ${mode === 'missing-filter' ? '[pscustomobject]@{}' : mode === 'filter-fail' ? "throw 'filter failed'" : `[pscustomobject]@{LocalAddress='Any';RemoteAddress='${mode === 'scoped' ? '10.0.0.0/8' : 'Any'}'}`} } }
function Get-NetFirewallServiceFilter { param([Parameter(ValueFromPipeline=$true)]$InputObject); process { [pscustomobject]@{Service='${mode === 'service' ? 'ScopedService' : 'Any'}'} } }
function Get-NetFirewallInterfaceFilter { param([Parameter(ValueFromPipeline=$true)]$InputObject); process { [pscustomobject]@{InterfaceAlias='${mode === 'interface' ? 'Ethernet' : 'Any'}'} } }
function Get-NetFirewallInterfaceTypeFilter { param([Parameter(ValueFromPipeline=$true)]$InputObject); process { [pscustomobject]@{InterfaceType='Any'} } }
function Get-NetFirewallSecurityFilter { param([Parameter(ValueFromPipeline=$true)]$InputObject); process { [pscustomobject]@{Authentication='${mode === 'security' ? 'Required' : 'NotRequired'}';Encryption='NotRequired'} } }
function Remove-NetFirewallRule { param($Name,$InputObject); $script:mutations++; if ($InputObject -ne $null) { 'CLEANUP_OWN_CREATED' }; $script:removed=$true }
function New-NetFirewallRule { param($Name,$DisplayName,$Description,$Group,$Direction,$Action,$Enabled,$Profile,$Program,$Protocol,$LocalPort,$RemotePort); $script:mutations++; $script:rule.Enabled='False'; $script:removed=$false; $script:rule }
function Set-NetFirewallRule { param($InputObject,$Enabled); $script:rule.Enabled=[string]$Enabled; ${mode === 'restore-mismatch' ? "$script:rule.Action='Block'" : ''} }
`;

test('firewall exports refuse filters and write failures, scoped rules, and incomplete legacy restores', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'purgeon-firewall-script-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const mode of ['filter-fail', 'missing-filter', 'scoped', 'service', 'interface', 'security', 'package', 'edge', 'write-fail', 'ok']) {
    const file = mode === 'write-fail' ? path.join(dir, 'absent', 'rule.json') : path.join(dir, `${mode}.json`);
    const out = await probe(firewallRemovalScript('Fixture', file), firewallFixture(mode));
    assert.match(out, mode === 'ok' ? /MUTATIONS 1/ : /MUTATIONS 0/, out);
    assert.match(out, mode === 'ok' ? /SUCCEEDED/ : /REFUSED/, out);
  }
  const legacy = path.join(dir, 'legacy.json');
  fs.writeFileSync(legacy, JSON.stringify({ Name: 'Fixture', DisplayName: 'Fixture' }));
  const refused = await probe(firewallRestoreScript('Fixture', legacy), firewallFixture('ok'));
  assert.match(refused, /older or incomplete/);
  assert.match(refused, /MUTATIONS 0/);
  const valid = path.join(dir, 'ok.json');
  const collision = await probe(firewallRestoreScript('Fixture', valid), firewallFixture('ok'));
  assert.match(collision, /already exists/);
  assert.match(collision, /MUTATIONS 0/);
  const restored = await probe(firewallRestoreScript('Fixture', valid), `${firewallFixture('ok')}\n$script:removed=$true`);
  assert.match(restored, /SUCCEEDED/, restored);
  assert.match(restored, /MUTATIONS 1/);
  assert.ok(fs.statSync(valid).size > 0);
  const mismatch = await probe(firewallRestoreScript('Fixture', valid), `${firewallFixture('restore-mismatch')}\n$script:removed=$true`);
  assert.match(mismatch, /REFUSED/);
  assert.match(mismatch, /MUTATIONS 2/);
  assert.match(mismatch, /CLEANUP_OWN_CREATED/);
});
