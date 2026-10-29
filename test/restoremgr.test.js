// System Restore management: vssadmin output parsing and point-to-shadow
// matching (the parts that can be wrong without Windows noticing).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseShadowStorage, wmiTimeToMs, matchShadowId } from '../src/backend/restoremgr.js';

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
  const ms = Date.UTC(2026, 9, 28, 14, 30, 22, 123);
  assert.equal(wmiTimeToMs('20261028143022.123456-300'), ms);
  assert.equal(wmiTimeToMs(`/Date(${ms})/`), ms);
  assert.equal(wmiTimeToMs('not a date'), null);
});

test('a restore point matches the shadow copy created at the same moment', () => {
  const ms = Date.UTC(2026, 9, 28, 14, 30, 22, 0);
  const point = { CreationTime: '20261028143022.000000-300' };
  const shadows = [
    { ID: '{aaaa}', InstallDate: `/Date(${ms - 86400000})/` },
    { ID: '{bbbb}', InstallDate: `/Date(${ms + 900})/` },
  ];
  assert.equal(matchShadowId(point, shadows), '{bbbb}');
  assert.equal(matchShadowId(point, [shadows[0]]), null, 'a day away is not a match');
  assert.equal(matchShadowId({ CreationTime: '' }, shadows), null);
});
