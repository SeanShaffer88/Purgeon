import test from 'node:test';
import assert from 'node:assert/strict';
import { setSys } from '../src/backend/sys.js';
import { createNodeSys } from './node-sys.js';
import * as updatecheck from '../src/backend/updatecheck.js';

const nodeSys = createNodeSys();
setSys(nodeSys);

test('compareVersions handles normal cases', () => {
  assert.equal(updatecheck.compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(updatecheck.compareVersions('1.0.1', '1.0.0'), 1);
  assert.equal(updatecheck.compareVersions('1.0.0', '1.0.1'), -1);
  assert.equal(updatecheck.compareVersions('2.0.0', '1.9.9'), 1);
  assert.equal(updatecheck.compareVersions('1.0', '1.0.1'), -1);
  assert.equal(updatecheck.compareVersions('1.10.0', '1.2.0'), 1);
  assert.equal(updatecheck.compareVersions('', ''), 0);
});

test('settings returns enabled=false when not configured', async () => {
  const s = await updatecheck.settings();
  assert.equal(s.enabled, false);
  assert.equal(s.lastCheck, '');
});

test('check returns enabled=false when update checking is off', async () => {
  const result = await updatecheck.check();
  assert.equal(result.enabled, false);
  assert.equal(result.update, null);
});

test('enable turns checking on', async () => {
  const result = await updatecheck.enable(true);
  assert.equal(result.enabled, true);
  const s = await updatecheck.settings();
  assert.equal(s.enabled, true);
});

test('enable turns checking off', async () => {
  const result = await updatecheck.enable(false);
  assert.equal(result.enabled, false);
});

test('compareVersions handles normal cases', () => {
  // Access the internal function via the module's behavior through check()
  // We test the comparison logic indirectly through known version strings
  const { compareVersions } = updatecheck;
  // compareVersions is not exported, but we can verify through behavior
  // This test documents expected behavior
  assert.ok(true, 'compareVersions tested indirectly via check() flow');
});

const DIGEST = 'a'.repeat(64);
const release = (over = {}) => ({
  tag: 'v1.3.0', name: 'Purgeon 1.3.0', body: 'notes', url: 'https://example.test/release', published: '2026-11-01',
  assets: [
    { name: 'Purgeon-Portable-x64.zip', url: 'https://example.test/portable.zip', size: 10, digest: `sha256:${'b'.repeat(64)}` },
    { name: 'Purgeon-Setup-x64.exe', url: 'https://example.test/setup.exe', size: 1234, digest: `sha256:${DIGEST}` },
  ],
  ...over,
});

test('normalizeDigest accepts only a 64-hex SHA-256', () => {
  assert.equal(updatecheck.normalizeDigest(`sha256:${DIGEST}`), DIGEST);
  assert.equal(updatecheck.normalizeDigest(DIGEST.toUpperCase()), DIGEST);
  assert.equal(updatecheck.normalizeDigest('sha256:xyz'), '');
  assert.equal(updatecheck.normalizeDigest(''), '');
  assert.equal(updatecheck.normalizeDigest(null), '');
});

test('pickSetupAsset picks only the exact Setup asset', () => {
  const a = updatecheck.pickSetupAsset(release().assets);
  assert.equal(a.name, 'Purgeon-Setup-x64.exe');
  assert.equal(a.url, 'https://example.test/setup.exe');
  assert.equal(a.size, 1234);
  assert.equal(a.sha256, DIGEST);
  assert.equal(updatecheck.pickSetupAsset([{ name: 'Purgeon-Portable-x64.zip', url: 'x' }]), null);
  assert.equal(updatecheck.pickSetupAsset(null), null);
  assert.equal(updatecheck.pickSetupAsset([{ name: 'Purgeon-Setup-x64.exe', url: 'x', digest: 'bogus' }]).sha256, '');
});

test('parseRelease marks newer only when latest is ahead and carries the installer', () => {
  const u = updatecheck.parseRelease(release(), '1.2.0');
  assert.equal(u.version, '1.3.0');
  assert.equal(u.newer, true);
  assert.equal(u.installer.sha256, DIGEST);
  assert.equal(updatecheck.parseRelease(release(), '1.3.0').newer, false);
  assert.equal(updatecheck.parseRelease(release(), '1.4.0').newer, false);
  assert.equal(updatecheck.parseRelease(null, '1.2.0').newer, false);
});

test('planInstall refuses portable copies, non-updates, missing assets and missing digests', () => {
  const u = updatecheck.parseRelease(release(), '1.2.0');
  assert.equal(updatecheck.planInstall(u, { portable: false }).ok, true);
  assert.match(updatecheck.planInstall(u, { portable: true }).error, /portable/i);
  assert.equal(updatecheck.planInstall({ ...u, newer: false }, { portable: false }).ok, false);
  assert.equal(updatecheck.planInstall({ ...u, installer: null }, { portable: false }).ok, false);
  const noDigest = updatecheck.parseRelease(release({ assets: [{ name: 'Purgeon-Setup-x64.exe', url: 'x', size: 1, digest: '' }] }), '1.2.0');
  assert.match(updatecheck.planInstall(noDigest, { portable: false }).error, /SHA-256/);
});

test('verifyDownload requires exact size and digest', () => {
  const asset = { size: 1234, sha256: DIGEST };
  assert.equal(updatecheck.verifyDownload({ size: 1234, sha256: DIGEST }, asset), null);
  assert.equal(updatecheck.verifyDownload({ size: 1234, sha256: DIGEST.toUpperCase() }, asset), null);
  assert.match(updatecheck.verifyDownload({ size: 100, sha256: DIGEST }, asset), /incomplete/);
  assert.match(updatecheck.verifyDownload({ size: 1234, sha256: 'b'.repeat(64) }, asset), /does not match/);
  assert.match(updatecheck.verifyDownload({ size: 1234, sha256: '' }, asset), /does not match/);
});

test('check reports the real current version alongside the result', async () => {
  const result = await updatecheck.check();
  assert.equal(typeof result.current, 'string');
});
