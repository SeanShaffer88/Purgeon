import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setSys } from '../src/backend/sys.js';
import { markerPath, shouldExitForMarker, checkExitMarker } from '../src/backend/updateexit.js';

const NOW = 1760000000000;

test('markerPath sits next to the program', () => {
  assert.equal(markerPath('C:\\Program Files\\Purgeon\\Purgeon.exe'), 'C:\\Program Files\\Purgeon\\exit-for-update');
  assert.equal(markerPath(''), '');
  assert.equal(markerPath(undefined), '');
});

test('shouldExitForMarker only accepts fresh files', () => {
  assert.equal(shouldExitForMarker({ modified: NOW - 30000 }, NOW), true);
  assert.equal(shouldExitForMarker({ modified: NOW - 119000 }, NOW), true);
  assert.equal(shouldExitForMarker({ modified: NOW - 121000 }, NOW), false);
  assert.equal(shouldExitForMarker({ modified: NOW + 3000 }, NOW), true, 'small clock skew is tolerated');
  assert.equal(shouldExitForMarker({ modified: NOW + 60000 }, NOW), false);
  assert.equal(shouldExitForMarker(null, NOW), false);
  assert.equal(shouldExitForMarker({ modified: NOW - 1000, dir: true }, NOW), false);
});

function fakeSys(stat, calls) {
  setSys({
    info: { exe: 'C:\\Program Files\\Purgeon\\Purgeon.exe', env: {} },
    stat: async () => stat,
    removePath: async (p) => { calls.push(['remove', p]); },
    quit: async () => { calls.push(['quit']); },
  });
}

test('checkExitMarker quits for a fresh marker and removes it', async () => {
  const calls = [];
  fakeSys({ modified: NOW - 5000, size: 4 }, calls);
  assert.equal(await checkExitMarker(NOW), true);
  assert.deepEqual(calls.map((c) => c[0]), ['remove', 'quit']);
});

test('checkExitMarker removes a stale marker without quitting', async () => {
  const calls = [];
  fakeSys({ modified: NOW - 3600000, size: 4 }, calls);
  assert.equal(await checkExitMarker(NOW), false);
  assert.deepEqual(calls.map((c) => c[0]), ['remove']);
});

test('checkExitMarker does nothing without a marker', async () => {
  const calls = [];
  fakeSys(null, calls);
  assert.equal(await checkExitMarker(NOW), false);
  assert.deepEqual(calls, []);
});
