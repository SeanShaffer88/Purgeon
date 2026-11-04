import test from 'node:test';
import assert from 'node:assert/strict';
import { setSys, sys } from '../src/backend/sys.js';
import * as duplicates from '../src/backend/duplicates.js';

const paths = ['C:\\AuditFiles\\a', 'C:\\AuditFiles\\b', 'C:\\AuditFiles\\c'];
async function fixture(count = 3) {
  const files = new Map(paths.slice(0, count).map((p) => [p, { size: 10, dir: false, modified: 1, hash: 'a'.repeat(64) }]));
  const trashed = [], hashes = [];
  setSys({ info: { env: {}, home: 'C:\\FixtureHome', dataDir: 'C:\\FixtureApp' },
    beginScans: async () => {}, walk: async () => [...files.keys()].map((p) => `F${p}`),
    stat: async (p) => { const f = files.get(p); return f ? { size: f.size, dir: f.dir, modified: f.modified } : null; },
    sha256Files: async (ps) => { hashes.push([...ps]); return ps.map((p) => files.get(p)?.hash || ''); },
    trash: async (p) => { trashed.push(p); files.delete(p); },
  });
  const scanned = await duplicates.scan(['C:\\AuditFiles']);
  hashes.length = 0;
  return { files, trashed, hashes, scanned };
}

test('successive and concurrent removals keep the final copy; returned scan data grants no deletion permission', async () => {
  for (const concurrent of [false, true]) {
    const f = await fixture(2);
    f.scanned.groups[0].files.push(paths[2]);
    duplicates.lastGroups()[0].files.push(paths[2]);
    const results = concurrent ? await Promise.all(paths.slice(0, 2).map((p) => duplicates.remove([p]))) :
      [await duplicates.remove([paths[0]]), await duplicates.remove([paths[1]])];
    assert.equal(results[0].removed, 1);
    assert.equal(results[1].ok, false);
    assert.equal(f.trashed.length, 1);
    assert.deepEqual(duplicates.lastGroups()[0].files, [paths[1]]);
    assert.equal(duplicates.lastGroups()[0].wasted, 0);
  }
});

test('partial trash failure updates membership immediately and retry revalidates the retained target', async () => {
  const f = await fixture();
  const trash = sys.trash;
  sys.trash = async (p) => { if (p === paths[1]) throw Error('trash denied'); await trash(p); };
  const result = await duplicates.remove(paths.slice(0, 2));
  assert.equal(result.removed, 1);
  assert.equal(result.ok, false);
  assert.match(result.results[1].error, /trash denied/);
  assert.deepEqual(duplicates.lastGroups()[0].files, paths.slice(1));
  sys.trash = trash;
  assert.equal((await duplicates.remove([paths[1]])).removed, 1);
  assert.equal((await duplicates.remove([paths[2]])).ok, false);
  assert.equal(f.hashes.length, 2);
  assert.deepEqual(f.hashes[1], paths.slice(1));
});

for (const fault of ['missing target', 'missing survivor', 'changed survivor', 'directory survivor', 'same-size changed target', 'unreadable target', 'failed hashes', 'short hashes', 'empty hashes', 'invalid hashes', 'metadata during hash', 'metadata before trash']) {
  test(`duplicate removal rejects ${fault}`, async () => {
    const f = await fixture(2);
    if (fault === 'missing target') f.files.delete(paths[0]);
    if (fault === 'missing survivor') f.files.delete(paths[1]);
    if (fault === 'changed survivor') f.files.get(paths[1]).hash = 'b'.repeat(64);
    if (fault === 'directory survivor') f.files.get(paths[1]).dir = true;
    if (fault === 'same-size changed target') f.files.get(paths[0]).hash = 'b'.repeat(64);
    if (fault === 'unreadable target') sys.stat = async () => { throw Error('denied'); };
    if (fault === 'failed hashes') sys.sha256Files = async () => { throw Error('hash denied'); };
    if (fault === 'short hashes') sys.sha256Files = async () => ['a'.repeat(64)];
    if (fault === 'empty hashes') sys.sha256Files = async () => ['', ''];
    if (fault === 'invalid hashes') sys.sha256Files = async () => ['bad', 'bad'];
    if (fault === 'metadata during hash') {
      const hash = sys.sha256Files;
      sys.sha256Files = async (ps) => { const result = await hash(ps); f.files.get(paths[0]).modified++; return result; };
    }
    if (fault === 'metadata before trash') {
      const stat = sys.stat;
      let reads = 0;
      sys.stat = async (p) => { if (++reads === 5) f.files.get(paths[0]).modified++; return stat(p); };
    }
    const result = await duplicates.remove([paths[0]]);
    assert.equal(result.ok, false);
    assert.equal(result.removed, 0);
    assert.deepEqual(f.trashed, []);
  });
}

test('case aliases are one file and selecting every distinct copy deletes nothing', async () => {
  const f = await fixture(2);
  sys.walk = async () => [`F${paths[0]}`, `F${paths[0].toUpperCase()}`, `F${paths[1]}`];
  const result = await duplicates.scan(['C:\\AuditFiles']);
  assert.equal(result.groups[0].files.length, 2);
  assert.equal((await duplicates.remove([paths[0].toUpperCase(), paths[1]])).ok, false);
  assert.deepEqual(f.trashed, []);
});

test('scan publication waits for active removal and each affected candidate is hashed once', async () => {
  const f = await fixture();
  let release, entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  const trash = sys.trash;
  sys.trash = async (p) => { entered(); await new Promise((resolve) => { release = resolve; }); await trash(p); };
  const removal = duplicates.remove([paths[0]]);
  await ready;
  let published = false;
  const scanning = duplicates.scan(['C:\\AuditFiles']).then((r) => { published = true; return r; });
  await new Promise(setImmediate);
  assert.equal(published, false);
  release();
  assert.equal((await removal).removed, 1);
  assert.equal((await scanning).groups[0].files.length, 2);
  assert.deepEqual(f.hashes[0], paths);
});

test('multiple selected targets share bounded hash batches', async () => {
  const f = await fixture();
  assert.equal((await duplicates.remove(paths.slice(0, 2))).removed, 2);
  assert.deepEqual(f.hashes, [paths]);
});
