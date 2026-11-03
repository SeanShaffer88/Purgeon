import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDERS, providerForServers, dohModeFor, buildApplyScript, buildResetScript } from '../src/backend/dns.js';

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

test('buildApplyScript sets the provider servers and registers DoH the chosen way', () => {
  const only = buildApplyScript({ index: 7, provider: 'cloudflare', doh: 'only' });
  assert.match(only, /Set-DnsClientServerAddress -InterfaceIndex 7 -ServerAddresses @\('1\.1\.1\.1','1\.0\.0\.1'\)/);
  assert.match(only, /Add-DnsClientDohServerAddress -ServerAddress '1\.1\.1\.1' -DohTemplate 'https:\/\/cloudflare-dns\.com\/dns-query' -AutoUpgrade \$True -AllowFallbackToUdp \$False/);
  assert.match(only, /Clear-DnsClientCache/);
  const preferred = buildApplyScript({ index: 3, provider: 'quad9', doh: 'preferred' });
  assert.match(preferred, /-AllowFallbackToUdp \$True/);
  const off = buildApplyScript({ index: 3, provider: 'google', doh: 'off' });
  assert.doesNotMatch(off, /Add-DnsClientDohServerAddress -ServerAddress/, 'off never registers new DoH entries');
  assert.match(off, /Set-DnsClientDohServerAddress -ServerAddress '8\.8\.8\.8'.*-AutoUpgrade \$False/);
});

test('buildApplyScript refuses unvalidated input', () => {
  assert.throws(() => buildApplyScript({ index: 0, provider: 'cloudflare', doh: 'only' }), /adapter/);
  assert.throws(() => buildApplyScript({ index: '7; evil', provider: 'cloudflare', doh: 'only' }), /adapter/);
  assert.throws(() => buildApplyScript({ index: 7, provider: 'evil', doh: 'only' }), /Unknown DNS provider/);
  assert.throws(() => buildApplyScript({ index: 7, provider: 'cloudflare', doh: 'sometimes' }), /DoH mode/);
});

test('buildResetScript hands the adapter back to automatic', () => {
  const s = buildResetScript({ index: 12 });
  assert.match(s, /Set-DnsClientServerAddress -InterfaceIndex 12 -ResetServerAddresses/);
  assert.throws(() => buildResetScript({ index: -1 }), /adapter/);
});

test('every provider has two servers and an https DoH template', () => {
  for (const p of Object.values(PROVIDERS)) {
    assert.equal(p.servers.length, 2);
    assert.match(p.dohTemplate, /^https:\/\//);
  }
});
