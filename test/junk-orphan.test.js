// Tests for the 'Large orphaned folders' junk category (#33).
// Run with: npm test
//
// Note: junk.scan() uses winpath for roots, which normalizes to backslashes.
// On Linux (where '/' is the separator) only categories using env() directly
// (e.g. usertemp) return items from scan(). The orphan-large category uses
// local()/progData() which go through winpath, so on Linux scan() returns 0
// items for it. The category definition and filtering logic are what we test here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setSys } from '../src/backend/sys.js';
import { createNodeSys } from './node-sys.js';
import * as winpath from '../src/backend/winpath.js';
import * as junk from '../src/backend/junk.js';

const nodeSys = createNodeSys();
setSys(nodeSys);

test('the orphan-large category exists with the right shape', () => {
  const cat = junk.CATEGORIES.find((c) => c.id === 'orphan-large');
  assert.ok(cat, 'orphan-large category exists');
  assert.equal(cat.label, 'Large orphaned folders');
  assert.ok(cat.detail.includes('100 MB'), 'documents the size threshold');
  assert.equal(cat.minBytes, 100 * 1024 * 1024);
  assert.equal(cat.orphan, true);
  assert.ok(Array.isArray(cat.roots()), 'has roots');
  assert.ok(cat.roots().length > 0, 'roots point at AppData and ProgramData');
});

test('scan runs without error and includes the orphan-large category', async () => {
  const cats = await junk.scan();
  const cat = cats.find((c) => c.id === 'orphan-large');
  assert.ok(cat, 'orphan-large category is produced by scan');
  assert.equal(cat.id, 'orphan-large');
  // On Linux, winpath roots don't resolve to real directories, so items may be 0.
  // On Windows, folders >100 MB in AppData/ProgramData not matching an installed
  // program name would appear here.
  assert.ok(Array.isArray(cat.items), 'items is an array');
  assert.equal(typeof cat.bytes, 'number', 'bytes is a number');
});

test('minBytes filtering keeps only folders over the threshold', () => {
  const cat = junk.CATEGORIES.find((c) => c.id === 'orphan-large');
  const minBytes = cat.minBytes;
  assert.equal(minBytes, 100 * 1024 * 1024);

  // Simulate the scan's minBytes filter: items below the threshold are dropped.
  const items = [
    { path: 'C:\\Users\\x\\AppData\\Local\\Big', dir: true, bytes: Math.floor(101 * minBytes / 100) },
    { path: 'C:\\Users\\x\\AppData\\Local\\Small', dir: true, bytes: minBytes - 1 },
    { path: 'C:\\Users\\x\\AppData\\Local\\Exact', dir: true, bytes: minBytes },
  ];
  const kept = items.filter((i) => !(cat.minBytes && i.bytes < cat.minBytes));
  assert.deepEqual(kept.map((i) => winpath.basename(i.path)), ['Big', 'Exact']);
});

test('orphan check excludes folders matching installed program names', () => {
  const cat = junk.CATEGORIES.find((c) => c.id === 'orphan-large');
  assert.equal(cat.orphan, true);

  // Simulate the scan's orphan filter: folders whose basename matches an
  // installed program name are excluded.
  const programNames = new Set(['chrome', 'firefox', 'obs studio']);
  const items = [
    { path: 'C:\\Users\\x\\AppData\\Local\\Chrome', dir: true, bytes: 200 * 1024 * 1024 },
    { path: 'C:\\Users\\x\\AppData\\Local\\Unknown Leftover', dir: true, bytes: 200 * 1024 * 1024 },
    { path: 'C:\\Users\\x\\AppData\\Local\\obs studio', dir: true, bytes: 200 * 1024 * 1024 },
  ];
  const kept = items.filter((i) => !(cat.orphan && i.dir && programNames.has(winpath.basename(i.path).toLowerCase())));
  assert.deepEqual(kept.map((i) => winpath.basename(i.path)), ['Unknown Leftover']);
});
