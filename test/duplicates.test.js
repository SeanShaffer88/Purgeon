import test from 'node:test';
import assert from 'node:assert/strict';
import { setSys } from '../src/backend/sys.js';
import { createNodeSys } from './node-sys.js';
import * as duplicates from '../src/backend/duplicates.js';

setSys(createNodeSys());

test('groupBySize keeps only sizes with two or more files', () => {
  const bySize = duplicates.groupBySize([
    { path: 'a', size: 10 }, { path: 'b', size: 10 }, { path: 'c', size: 20 },
    { path: 'd', size: 0 }, { path: '', size: 10 }, { path: 'e', size: 10 },
  ]);
  assert.deepEqual([...bySize.keys()], [10]);
  assert.deepEqual(bySize.get(10), ['a', 'b', 'e']);
});

test('buildGroups joins only equal hashes and sorts by wasted space', () => {
  const bySize = new Map([[100, ['a', 'b', 'c']], [50, ['x', 'y']]]);
  const hashOf = new Map([['a', 'H1'], ['b', 'h1'], ['c', 'H2'], ['x', 'H9'], ['y', '']]);
  const groups = duplicates.buildGroups(bySize, hashOf);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].sha256, 'h1');
  assert.deepEqual(groups[0].files, ['a', 'b']);
  assert.equal(groups[0].wasted, 100);
});

test('lastCopies blocks removing every copy of a group', () => {
  const groups = [{ sha256: 'h', size: 1, files: ['a', 'b', 'c'], wasted: 2 }];
  assert.deepEqual(duplicates.lastCopies(groups, ['a', 'b']), []);
  assert.deepEqual(duplicates.lastCopies(groups, ['a', 'b', 'c']), ['a', 'b', 'c']);
});

test('scan refuses protected locations', async () => {
  const r = await duplicates.scan(['C:\\Windows']);
  assert.equal(r.groups.length, 0);
  assert.match(r.error, /Protected/);
});

// A Windows-shaped fake system layer: the app only ever runs on Windows paths, and
// the shared protection guard refuses anything that is not a drive path.
function fakeSys() {
  const sizes = { 'C:\\Data\\a.txt': 18, 'C:\\Data\\b.txt': 18, 'C:\\Data\\c.txt': 19 };
  const hashes = { 'C:\\Data\\a.txt': '1'.repeat(64), 'C:\\Data\\b.txt': '1'.repeat(64), 'C:\\Data\\c.txt': '2'.repeat(64) };
  const trashed = [];
  return {
    trashed,
    info: { env: {}, home: 'C:\\Users\\Test', dataDir: 'C:\\Data\\app', exe: 'C:\\Data\\app\\Purgeon.exe' },
    walk: async () => Object.keys(sizes).map((p) => `F${p}`),
    stat: async (p) => (sizes[p] ? { size: sizes[p], dir: false } : null),
    sha256Files: async (paths) => paths.map((p) => hashes[p] || ''),
    trash: async (p) => { trashed.push(p); },
    beginScans: async () => {},
  };
}

test('scan finds identical files by content and remove keeps one copy', async () => {
  const fake = fakeSys();
  setSys(fake);
  try {
    const r = await duplicates.scan(['C:\\Data']);
    assert.equal(r.groups.length, 1);
    assert.deepEqual(r.groups[0].files, ['C:\\Data\\a.txt', 'C:\\Data\\b.txt']);
    const both = await duplicates.remove(r.groups[0].files);
    assert.equal(both.ok, false);
    assert.match(both.error, /last copy/);
    assert.deepEqual(fake.trashed, []);
    const one = await duplicates.remove(['C:\\Data\\a.txt']);
    assert.equal(one.ok, true);
    assert.deepEqual(fake.trashed, ['C:\\Data\\a.txt']);
  } finally {
    setSys(createNodeSys());
  }
});
