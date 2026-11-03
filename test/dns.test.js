import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setSys } from '../src/backend/sys.js';
import { PROVIDERS, providerForServers, dohModeFor, buildApplyScript, buildResetScript, buildNagleScript, status, setNagle } from '../src/backend/dns.js';

test('providerForServers matches exact provider lists, in any order', () => {
  assert.equal(providerForServers(['1.1.1.1', '1.0.0.1']), 'cloudflare');
  assert.equal(providerForServers(['1.0.0.1', '1.1.1.1']), 'cloudflare');
  assert.equal(providerForServers(['8.8.8.8', '8.8.4.4']), 'google');
  assert.equal(providerForServers(['9.9.9.9', '149.112.112.112']), 'quad9');
  assert.equal(providerForServers([]), 'automatic');
  assert.equal(providerForServers(['1.1.1.1']), 'custom', 'a partial provider list is custom');
  assert.equal(providerForServers(['192.168.1.1']), 'custom');
});

test('dohModeFor reads registered entries', () => {
  assert.equal(dohModeFor([]), 'off');
  assert.equal(dohModeFor([{ autoUpgrade: false, fallback: false }]), 'off');
  assert.equal(dohModeFor([{ autoUpgrade: true, fallback: true }]), 'preferred');
  assert.equal(dohModeFor([{ autoUpgrade: true, fallback: false }]), 'only');
  assert.equal(dohModeFor([{ autoUpgrade: true, fallback: false }, { autoUpgrade: false, fallback: false }]), 'off', 'one un-upgraded server means DoH is not really on');
});

test('buildApplyScript refuses unvalidated input', () => {
  assert.throws(() => buildApplyScript({ index: 0, provider: 'cloudflare', doh: 'only' }), /adapter/);
  assert.throws(() => buildApplyScript({ index: '7; evil', provider: 'cloudflare', doh: 'only' }), /adapter/);
  assert.throws(() => buildApplyScript({ index: 7, provider: 'evil', doh: 'only' }), /Unknown DNS provider/);
  assert.throws(() => buildApplyScript({ index: 7, provider: 'cloudflare', doh: 'sometimes' }), /DoH mode/);
  for (const index of [NaN, Infinity, 1.5, 2147483648, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => buildApplyScript({ index, provider: 'cloudflare', doh: 'only' }), /adapter/);
  }
  for (const provider of ['constructor', '__proto__', 'toString', null, {}]) {
    assert.throws(() => buildApplyScript({ index: 7, provider, doh: 'only' }), /Unknown DNS provider/);
  }
});

test('buildResetScript hands the adapter back to automatic', () => {
  const s = buildResetScript({ index: 12 });
  assert.match(s, /\$index = 12/);
  assert.match(s, /-ResetServerAddresses -ErrorAction Stop/);
  assert.throws(() => buildResetScript({ index: -1 }), /adapter/);
});

test('every provider has two servers and an https DoH template', () => {
  for (const p of Object.values(PROVIDERS)) {
    assert.equal(p.servers.length, 2);
    assert.match(p.dohTemplate, /^https:\/\//);
  }
});

test('buildNagleScript finds the interface key from the adapter number', () => {
  const on = buildNagleScript({ index: 5, off: true });
  assert.match(on, /ifIndex -eq 5/);
  assert.match(on, /New-ItemProperty -Path \$path -Name \$name -PropertyType DWord -Value 1/);
  assert.doesNotMatch(on, /New-Item -/, 'the interface key must already exist');
  assert.doesNotMatch(on, /Interfaces\\\\\{/, 'no caller-supplied GUID is baked into the path');
  const off = buildNagleScript({ index: 5, off: false });
  assert.match(off, /Remove-ItemProperty -Path \$path -Name \$name -ErrorAction Stop/);
  assert.throws(() => buildNagleScript({ index: -2, off: true }), /adapter/);
  assert.throws(() => buildNagleScript({ index: 5, off: 'yes' }), /Nagle/);
});

test('status accepts the singleton envelope produced by runPSJson and rejects malformed output', async () => {
  setSys({ runPS: async () => JSON.stringify({ adapters: [{ index: 5, alias: 'Fixture', status: 'Up', servers: ['1.1.1.1', '1.0.0.1'] }], dohSupported: true, doh: [] }) });
  assert.equal((await status()).adapters[0].provider, 'cloudflare');
  setSys({ runPS: async () => '{}' });
  await assert.rejects(status(), /network adapters/);
  setSys({ runPS: async () => { throw new Error('Access is denied. Rollback failed: fixture'); } });
  await assert.rejects(setNagle({ index: 5, off: true }), /administrator rights.*Rollback failed: fixture/);
});

// All system commands used by the generated scripts are shadowed by in-memory
// functions. No real adapter, registry provider, DNS cache or network is touched.
const fixture = `
$script:writes = @()
$script:attempt = 0
$script:rollbackPhase = $false
$script:servers = @('192.0.2.1')
$script:explicit = $true
$script:entries = @{}
$script:values = @{}
$script:mode = 'ok'
$script:shared = $false
function Get-Command { param($Name, $ErrorAction); if ($script:mode -ne 'unsupported' -and -not ($script:mode -eq 'missing-remove' -and $Name -eq 'Remove-DnsClientDohServerAddress') -and -not ($script:mode -eq 'missing-set' -and $Name -eq 'Set-DnsClientDohServerAddress')) { [pscustomobject]@{ Name = $Name } } }
function Get-NetAdapter { [CmdletBinding()] param(); [pscustomobject]@{ ifIndex = 5; InterfaceGuid = '{fixture}'; Status = 'Up' } }
function Get-ItemProperty { [CmdletBinding()] param($Path); [pscustomobject]@{ TcpNoDelay = 0; TcpAckFrequency = 0 } }
function Get-Item {
  [CmdletBinding()] param($LiteralPath)
  if ($script:mode -eq 'missing-key') { throw 'key absent' }
  $key = [pscustomobject]@{}
  $key | Add-Member ScriptMethod GetValueNames { @($script:values.Keys) }
  $key | Add-Member ScriptMethod GetValueKind { param($name); $script:values[$name].Kind }
  $key | Add-Member ScriptMethod GetValue { param($name,$default,$options); if ($name -eq 'NameServer') { if ($script:explicit) { $script:servers -join ',' } else { '' } } elseif ($script:values.ContainsKey($name)) { return ,$script:values[$name].Value } else { $default } }
  $key | Add-Member ScriptMethod Close {}
  $key
}
function Get-DnsClientServerAddress {
  [CmdletBinding()] param($InterfaceIndex,$AddressFamily)
  [pscustomobject]@{ InterfaceIndex = 5; InterfaceAlias = 'Fixture'; AddressFamily = 2; ServerAddresses = $script:servers }
  if (-not $PSBoundParameters.ContainsKey('InterfaceIndex') -and $script:shared) { [pscustomobject]@{ InterfaceIndex = 6; ServerAddresses = @('1.1.1.1') } }
}
function Get-DnsClientDohServerAddress { [CmdletBinding()] param(); @($script:entries.Values) }
function Record-Write($kind) {
  $script:writes += $kind
  $script:attempt++
  if ($script:rollbackPhase -and $script:mode -eq 'rollback-fail') { throw 'rollback denied' }
  if (($script:mode -in @('partial','rollback-fail') -and $script:attempt -eq 2) -or ($script:mode -eq 'doh-fail' -and $kind -eq 'doh')) { $script:rollbackPhase = $true; Write-Error 'Access is denied (fixture)' }
}
function Add-DnsClientDohServerAddress {
  [CmdletBinding()] param($ServerAddress,$DohTemplate,$AutoUpgrade,$AllowFallbackToUdp)
  Record-Write 'doh'
  $script:entries[$ServerAddress] = [pscustomobject]@{ ServerAddress = $ServerAddress; DohTemplate = $DohTemplate; AutoUpgrade = $AutoUpgrade; AllowFallbackToUdp = $AllowFallbackToUdp }
  if ($script:mode -eq 'doh-mismatch' -and -not $script:rollbackPhase) { $script:entries[$ServerAddress].AutoUpgrade = $false; $script:rollbackPhase = $true }
}
function Set-DnsClientDohServerAddress { [CmdletBinding()] param($ServerAddress,$DohTemplate,$AutoUpgrade,$AllowFallbackToUdp); Add-DnsClientDohServerAddress @PSBoundParameters }
function Remove-DnsClientDohServerAddress { [CmdletBinding(SupportsShouldProcess=$true)] param($ServerAddress); Record-Write 'remove-doh'; $script:entries.Remove($ServerAddress) }
function Set-DnsClientServerAddress {
  [CmdletBinding()] param($InputObject,$ServerAddresses,[switch]$ResetServerAddresses)
  if ($InputObject.InterfaceIndex -ne 5 -or $InputObject.AddressFamily -ne 2) { throw 'mutation must use the selected IPv4 input object' }
  Record-Write 'dns'
  $script:explicit = -not $ResetServerAddresses
  $script:servers = if ($ResetServerAddresses) { @('192.0.2.254') } else { @($ServerAddresses) }
  if ($script:mode -in @('dns-mismatch','dns-rollback-fail') -and -not $script:rollbackPhase) { $script:servers = @('192.0.2.99'); $script:rollbackPhase = $true }
  elseif ($script:mode -eq 'dns-rollback-fail' -and $script:rollbackPhase) { throw 'restore DNS denied' }
}
function Clear-DnsClientCache { [CmdletBinding()] param(); if ($script:mode -eq 'cache-fail') { throw 'cache failure' } }
function New-ItemProperty {
  [CmdletBinding()] param($Path,$Name,$PropertyType,$Value,[switch]$Force)
  Record-Write 'registry-set'
  if ($PropertyType -eq 'Binary') { $Value = [byte[]]@($Value) }
  elseif ($PropertyType -eq 'MultiString') { $Value = [string[]]@($Value) }
  if ($script:mode -ne 'nagle-mismatch' -or $script:rollbackPhase) { $script:values[$Name] = [pscustomobject]@{ Kind = [string]$PropertyType; Value = $Value } }
  else { $script:rollbackPhase = $true }
  if ($script:mode -eq 'partial-after' -and $script:attempt -eq 2) { $script:rollbackPhase = $true; Write-Error 'failed after write' }
}
function Remove-ItemProperty { [CmdletBinding()] param($Path,$Name); Record-Write 'registry-remove'; if (-not $script:values.ContainsKey($Name)) { throw 'value absent' }; $script:values.Remove($Name) }
`;

async function probe(script, setup = '') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'purgeon-dns-script-'));
  try {
    const filename = path.join(dir, 'fixture.ps1');
    const body = `${fixture}\n${setup}\n$message = ''; $output = @(); try { $output = @(& { ${script} }) } catch { $message = $_.Exception.Message }; [pscustomobject]@{ message = $message; output = @($output); writes = @($script:writes); servers = @($script:servers); explicit = $script:explicit; entries = $script:entries; values = $script:values } | ConvertTo-Json -Depth 12 -Compress`;
    await fs.writeFile(filename, body, 'utf8');
    const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', filename], { windowsHide: true, timeout: 30000 });
    return JSON.parse(stdout.trim());
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

const applyScript = (doh = 'only') => buildApplyScript({ index: 5, provider: 'cloudflare', doh });

test('status executes the actual PowerShell wire shape and never overstates partial DoH', async () => {
  const setup = "$script:servers=@('1.1.1.1','1.0.0.1'); $script:entries['1.1.1.1']=[pscustomobject]@{ServerAddress='1.1.1.1';DohTemplate='https://cloudflare-dns.com/dns-query';AutoUpgrade=$true;AllowFallbackToUdp=$false}";
  setSys({ runPS: async (script) => {
    const result = await probe(script, setup);
    assert.equal(result.message, '');
    assert.deepEqual(result.writes, []);
    return result.output.join('');
  } });
  const result = await status();
  assert.equal(result.adapters.length, 1);
  assert.equal(result.adapters[0].alias, 'Fixture');
  assert.equal(result.adapters[0].provider, 'cloudflare');
  assert.equal(result.adapters[0].doh, 'off');
});

test('encrypted DNS preflight refuses unsupported/missing operations and global conflicts without writes', async () => {
  for (const setup of ["$script:mode='unsupported'", "$script:mode='missing-remove'", '$script:shared=$true']) {
    const r = await probe(applyScript(), setup);
    assert.notEqual(r.message, '');
    assert.deepEqual(r.writes, []);
    assert.deepEqual(r.servers, ['192.0.2.1']);
  }
});

test('DNS commits only after verified DoH and rolls back setup failures before switching servers', async () => {
  const r = await probe(applyScript());
  assert.equal(r.message, '');
  assert.deepEqual(r.writes, ['doh', 'doh', 'dns']);
  assert.deepEqual(r.servers, ['1.1.1.1', '1.0.0.1']);
  assert.equal(r.entries['1.1.1.1'].AutoUpgrade, true);
  assert.equal(r.entries['1.1.1.1'].AllowFallbackToUdp, false);
  for (const mode of ['doh-fail', 'partial']) {
    const failed = await probe(applyScript(), `$script:mode='${mode}'`);
    assert.match(failed.message, /Access is denied.*Previous settings restored/);
    assert.equal(failed.writes.includes('dns'), false);
    assert.deepEqual(failed.entries, {});
  }
  const mismatch = await probe(applyScript(), "$script:mode='doh-mismatch'");
  assert.match(mismatch.message, /DoH registration verification failed.*Previous settings restored/);
  assert.equal(mismatch.writes.includes('dns'), false);
  assert.deepEqual(mismatch.entries, {});
});

test('DNS restores original global entries and handles preferred/off modes', async () => {
  const original = "$script:entries['1.1.1.1']=[pscustomobject]@{ServerAddress='1.1.1.1';DohTemplate='https://fixture.invalid/dns';AutoUpgrade=$false;AllowFallbackToUdp=$true}";
  const failed = await probe(applyScript(), `$script:mode='partial'; ${original}`);
  assert.match(failed.message, /Previous settings restored/);
  assert.deepEqual(failed.entries, { '1.1.1.1': { ServerAddress: '1.1.1.1', DohTemplate: 'https://fixture.invalid/dns', AutoUpgrade: false, AllowFallbackToUdp: true } });
  const missing = await probe(applyScript(), `$script:mode='missing-set'; ${original}`);
  assert.match(missing.message, /unavailable/);
  assert.deepEqual(missing.writes, []);
  const preferred = await probe(applyScript('preferred'));
  assert.equal(preferred.message, '');
  assert.equal(preferred.entries['1.1.1.1'].AllowFallbackToUdp, true);
  const off = await probe(applyScript('off'), original);
  assert.equal(off.message, '');
  assert.equal(off.entries['1.1.1.1'].AutoUpgrade, false);
  assert.equal(off.entries['1.1.1.1'].AllowFallbackToUdp, false);
});

test('DNS rollback restores explicit or automatic configuration and reports incomplete rollback', async () => {
  for (const explicit of [true, false]) {
    const r = await probe(applyScript(), `$script:mode='dns-mismatch'; $script:explicit=$${explicit}`);
    assert.match(r.message, /verification failed.*Previous settings restored/);
    assert.equal(r.explicit, explicit);
    assert.deepEqual(r.servers, explicit ? ['192.0.2.1'] : ['192.0.2.254']);
    assert.deepEqual(r.entries, {});
  }
  const failed = await probe(applyScript(), "$script:mode='dns-rollback-fail'");
  assert.match(failed.message, /Rollback failed.*restore DNS denied/);
});

test('automatic reset verifies mode and restores static servers on later failure', async () => {
  const r = await probe(buildResetScript({ index: 5 }));
  assert.equal(r.message, '');
  assert.equal(r.explicit, false);
  const failed = await probe(buildResetScript({ index: 5 }), "$script:mode='cache-fail'");
  assert.match(failed.message, /Previous settings restored/);
  assert.equal(failed.explicit, true);
  assert.deepEqual(failed.servers, ['192.0.2.1']);
});

test('compatible shared DoH registrations are reused and off works without DoH support', async () => {
  const shared = "$script:shared=$true; foreach ($s in @('1.1.1.1','1.0.0.1')) { $script:entries[$s]=[pscustomobject]@{ServerAddress=$s;DohTemplate='https://cloudflare-dns.com/dns-query';AutoUpgrade=$true;AllowFallbackToUdp=$false} }";
  const r = await probe(applyScript(), shared);
  assert.equal(r.message, '');
  assert.deepEqual(r.writes, ['dns']);
  const off = await probe(applyScript('off'), "$script:mode='unsupported'");
  assert.equal(off.message, '');
  assert.deepEqual(off.writes, ['dns']);
});

test('Nagle commits verify both values, only remove present values and require an existing interface', async () => {
  const on = await probe(buildNagleScript({ index: 5, off: true }));
  assert.equal(on.message, '');
  assert.deepEqual(on.values.TcpNoDelay, { Kind: 'DWord', Value: 1 });
  assert.deepEqual(on.values.TcpAckFrequency, { Kind: 'DWord', Value: 1 });
  const off = await probe(buildNagleScript({ index: 5, off: false }));
  assert.equal(off.message, '');
  assert.deepEqual(off.writes, []);
  const absent = await probe(buildNagleScript({ index: 5, off: true }), "$script:mode='missing-key'");
  assert.match(absent.message, /key absent/);
  assert.deepEqual(absent.writes, []);
  const remove = await probe(buildNagleScript({ index: 5, off: false }), "$script:values['TcpNoDelay']=[pscustomobject]@{Kind='DWord';Value=1}");
  assert.equal(remove.message, '');
  assert.deepEqual(remove.writes, ['registry-remove']);
  assert.deepEqual(remove.values, {});
});

test('Nagle partial failures restore raw kinds/data or absence and report failed rollback', async () => {
  const original = "$script:values['TcpNoDelay']=[pscustomobject]@{Kind='ExpandString';Value='%FIXTURE%'}; $script:values['TcpAckFrequency']=[pscustomobject]@{Kind='Binary';Value=[byte[]]@(3,4)}";
  for (const off of [true, false]) {
    const r = await probe(buildNagleScript({ index: 5, off }), `$script:mode='partial'; ${original}`);
    assert.match(r.message, /Access is denied.*Previous settings restored/);
    assert.deepEqual(r.values.TcpNoDelay, { Kind: 'ExpandString', Value: '%FIXTURE%' });
    assert.deepEqual(r.values.TcpAckFrequency, { Kind: 'Binary', Value: [3, 4] });
  }
  const absent = await probe(buildNagleScript({ index: 5, off: true }), "$script:mode='partial'");
  assert.match(absent.message, /Previous settings restored/);
  assert.deepEqual(absent.values, {});
  const mismatch = await probe(buildNagleScript({ index: 5, off: true }), "$script:mode='nagle-mismatch'");
  assert.match(mismatch.message, /verification failed.*Previous settings restored/);
  assert.deepEqual(mismatch.values, {});
  const failed = await probe(buildNagleScript({ index: 5, off: true }), `$script:mode='rollback-fail'; ${original}`);
  assert.match(failed.message, /Access is denied.*Rollback failed.*rollback denied/);
  const afterWrite = await probe(buildNagleScript({ index: 5, off: true }), `$script:mode='partial-after'; ${original}`);
  assert.match(afterWrite.message, /failed after write.*Previous settings restored/);
  assert.deepEqual(afterWrite.values.TcpAckFrequency, { Kind: 'Binary', Value: [3, 4] });
  const multi = await probe(buildNagleScript({ index: 5, off: true }), "$script:mode='partial'; $script:values['TcpNoDelay']=[pscustomobject]@{Kind='MultiString';Value=[string[]]@('one','two')} ");
  assert.match(multi.message, /Previous settings restored/);
  assert.deepEqual(multi.values.TcpNoDelay, { Kind: 'MultiString', Value: ['one', 'two'] });
});
