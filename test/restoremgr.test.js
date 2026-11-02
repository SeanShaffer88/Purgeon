// System Restore management: vssadmin output parsing and point-to-shadow
// matching (the parts that can be wrong without Windows noticing).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseShadowStorage, wmiTimeToMs, matchShadowId, removePoint } from '../src/backend/restoremgr.js';
import { setSys } from '../src/backend/sys.js';

const STORAGE = `
vssadmin 1.1 - Volume Shadow Copy Service administrative command-line tool

Shadow Copy Storage association
   For volume: (C:)\\\\?\\Volume{11111111-2222-3333-4444-555555555555}\\
   Shadow Copy Storage volume: (C:)\\\\?\\Volume{11111111-2222-3333-4444-555555555555}\\
   Used Shadow Copy Storage space: 4.56 GB
   Allocated Shadow Copy Storage space: 4.81 GB
   Maximum Shadow Copy Storage space: 10% (23.4 GB)

Shadow Copy Storage association
   For volume: (D:)\\\\?\\Volume{66666666-7777-8888-9999-000000000000}\\
   Shadow Copy Storage volume: (D:)\\\\?\\Volume{66666666-7777-8888-9999-000000000000}\\
   Used Shadow Copy Storage space: 812 MB
   Allocated Shadow Copy Storage space: 812 MB
   Maximum Shadow Copy Storage space: UNBOUNDED
`;

test('shadow storage parses per drive with percent and unbounded maxima', () => {
  const s = parseShadowStorage(STORAGE);
  assert.equal(s.length, 2);
  assert.deepEqual(s[0], { drive: 'C:', used: '4.56 GB', maxText: '10% (23.4 GB)', maxPct: 10, unbounded: false });
  assert.equal(s[1].drive, 'D:');
  assert.equal(s[1].maxPct, null);
  assert.equal(s[1].unbounded, true);
  assert.deepEqual(parseShadowStorage(''), []);
});

test('WMI and PowerShell date shapes both become epoch milliseconds', () => {
  const ms = Date.UTC(2026, 9, 28, 19, 30, 22, 123);
  assert.equal(wmiTimeToMs('20261028143022.123456-300'), ms);
  assert.equal(wmiTimeToMs(`/Date(${ms})/`), ms);
  assert.equal(wmiTimeToMs('not a date'), null);
  assert.equal(wmiTimeToMs('20261028143022.123456+330'), Date.UTC(2026, 9, 28, 9, 0, 22, 123));
  assert.equal(wmiTimeToMs('20261028143022.123456+000'), Date.UTC(2026, 9, 28, 14, 30, 22, 123));
  for (const invalid of ['20260230143022.123456-300', '20261028243022.123456-300', '20261028143022.123456***', '20261028143022.123456', Infinity, NaN]) assert.equal(wmiTimeToMs(invalid), null);
});

test('a restore point matches the shadow copy created at the same moment', () => {
  const ms = Date.UTC(2026, 9, 28, 19, 30, 22, 0);
  const point = { CreationTime: '20261028143022.000000-300' };
  const shadows = [
    { ID: '{aaaa}', InstallDate: `/Date(${ms - 86400000})/` },
    { ID: '{bbbb}', InstallDate: `/Date(${ms + 900})/` },
  ];
  assert.equal(matchShadowId(point, shadows), '{bbbb}');
  assert.equal(matchShadowId(point, [shadows[0]]), null, 'a day away is not a match');
  assert.equal(matchShadowId({ CreationTime: '' }, shadows), null);
  assert.equal(matchShadowId(point, [...shadows, { ID: '{cccc}', InstallDate: `/Date(${ms + 1000})/` }]), null, 'ambiguous matches are never deletion authority');
});

test('restore removal passes exact point identity only to the native prepared operation', async () => {
  const calls = [];
  setSys({
    exec: async () => { throw new Error('Generic execution must not delete restore points'); },
    runPS: async () => { throw new Error('Renderer scripts must not delete restore points'); },
    prepareRestoreRemoval: async (request) => { calls.push(request); return { id: 'opaque-native-plan' }; },
    executeRestoreRemoval: async (id) => { calls.push(id); return { ok: true, sequence: 42, journalId: 'journal' }; },
  });
  const point = { sequence: 42, created: '20261028143022.123456-300', description: 'Before tests' };
  assert.equal((await removePoint(point)).ok, true);
  assert.deepEqual(calls, [{ sequence: 42, expectedCreationTime: point.created, expectedDescription: point.description }, 'opaque-native-plan']);
  for (const invalid of [{ shadowId: '{bbbb}', description: 'forged' }, { ...point, sequence: -1 }, { ...point, created: '' }]) await assert.rejects(removePoint(invalid), /Refresh/);
});

test('native restore identity or verification refusal is surfaced without fallback deletion', async () => {
  const point = { sequence: 42, created: '20261028143022.123456-300', description: 'Before tests' };
  setSys({ prepareRestoreRemoval: async () => { throw new Error('Restore point changed'); } });
  await assert.rejects(removePoint(point), /changed/);
  setSys({ prepareRestoreRemoval: async () => ({ id: 'plan' }), executeRestoreRemoval: async () => ({ ok: true, sequence: 43 }) });
  await assert.rejects(removePoint(point), /could not be verified/);
});
