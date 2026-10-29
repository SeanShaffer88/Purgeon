// Event Logs: channel shaping and the Security-log guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelGuard, shapeChannels } from '../src/backend/eventlogs.js';

test('the Security log is guarded, everything else is not', () => {
  assert.ok(channelGuard('Security'));
  assert.ok(channelGuard(' security '));
  assert.equal(channelGuard('System'), null);
  assert.equal(channelGuard('Microsoft-Windows-PowerShell/Operational'), null);
});

test('channels shape with counts, sizes, enabled state and sort order', () => {
  const shaped = shapeChannels([
    { LogName: 'System', RecordCount: 1200, FileSize: 20971520, IsEnabled: true },
    { LogName: 'Application', RecordCount: null, FileSize: null, IsEnabled: true },
    { LogName: 'Security', RecordCount: 55, FileSize: 1048576, IsEnabled: true },
    { LogName: 'Forwarded Events', RecordCount: 0, FileSize: 0, IsEnabled: false },
    null,
  ]);
  assert.deepEqual(shaped.map((c) => c.name), ['Application', 'Forwarded Events', 'Security', 'System']);
  assert.equal(shaped[0].records, 0);
  assert.equal(shaped[1].enabled, false);
  assert.equal(shaped[2].guarded, true);
  assert.equal(shaped[3].guarded, false);
  assert.deepEqual(shapeChannels(null), []);
});
