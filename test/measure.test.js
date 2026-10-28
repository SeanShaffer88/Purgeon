// Store-app sizes: each package's own folder, measured directly; unreadable
// folders stay unmeasured rather than showing a guessed number.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setSys } from '../src/backend/sys.js';
import { createNodeSys } from './node-sys.js';
import { measureStoreApps } from '../src/backend/measure.js';

const nodeSys = createNodeSys();
const sizes = {
  'C:\\Program Files\\WindowsApps\\AppA_1.0': { bytes: 2048 * 1024, entries: 12, truncated: false },
  'C:\\Program Files\\WindowsApps\\AppB_2.0': { bytes: 0, entries: 0, truncated: false },
};
setSys({ ...nodeSys, folderSize: async (p) => sizes[p] || { bytes: 0, entries: 0, truncated: false } });

test('store apps are measured from their own package folders', async () => {
  const found = [];
  await measureStoreApps(
    [
      { key: 'a', location: 'C:\\Program Files\\WindowsApps\\AppA_1.0' },
      { key: 'b', location: 'C:\\Program Files\\WindowsApps\\AppB_2.0' },
      { key: 'c' },
    ],
    (r) => found.push(r)
  );
  assert.equal(found.length, 1, 'only the readable package folder reports a size');
  assert.equal(found[0].key, 'a');
  assert.equal(found[0].sizeKB, 2048);
  assert.equal(found[0].sizeMeasured, true);
});

test('store measurement stops when cancelled', async () => {
  const found = [];
  await measureStoreApps([{ key: 'a', location: 'C:\\Program Files\\WindowsApps\\AppA_1.0' }], (r) => found.push(r), () => true);
  assert.deepEqual(found, []);
});
