import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setSys } from '../src/backend/sys.js';
import { createNodeSys } from './node-sys.js';
import { sortEntries, crumbsOf, parentOf, shareText, scan, list, measureFolders, toText } from '../src/backend/diskusage.js';

test('sortEntries is biggest first, folders first on ties', () => {
  const out = sortEntries([
    { name: 'b.txt', dir: false, bytes: 100 },
    { name: 'A', dir: true, bytes: 100 },
    { name: 'big', dir: true, bytes: 5000 },
    { name: 'small.txt', dir: false, bytes: 3 },
  ]);
  assert.deepEqual(out.map((e) => e.name), ['big', 'A', 'b.txt', 'small.txt']);
});

test('crumbsOf splits a Windows path from the drive down', () => {
  assert.deepEqual(crumbsOf('C:\\'), [{ label: 'C:\\', path: 'C:\\' }]);
  assert.deepEqual(crumbsOf('C:\\Users\\Sean\\Downloads'), [
    { label: 'C:\\', path: 'C:\\' },
    { label: 'Users', path: 'C:\\Users' },
    { label: 'Sean', path: 'C:\\Users\\Sean' },
    { label: 'Downloads', path: 'C:\\Users\\Sean\\Downloads' },
  ]);
  assert.equal(parentOf('C:\\Users\\Sean'), 'C:\\Users');
  assert.equal(parentOf('C:\\Users'), 'C:\\');
  assert.equal(parentOf('C:\\'), null);
});

test('shareText formats a percentage of the parent total', () => {
  assert.equal(shareText(50, 200), '25.0%');
  assert.equal(shareText(1, 3), '33.3%');
  assert.equal(shareText(10, 0), '—');
});

test('scan measures children, skips links, and reports the total', async () => {
  const nodeSys = createNodeSys();
  setSys({
    ...nodeSys,
    readDir: async () => [
      { name: 'Docs', dir: true, file: false, link: false },
      { name: 'big.iso', dir: false, file: true, link: false },
      { name: 'Junction', dir: true, file: false, link: true },
    ],
    folderSize: async () => ({ bytes: 4096, entries: 9, truncated: false }),
    stat: async () => ({ size: 8192, dir: false, created: 0, modified: 0 }),
  });
  const r = await scan('C:\\Data');
  assert.equal(r.complete, true);
  assert.equal(r.total, 4096 + 8192);
  assert.deepEqual(r.entries.map((e) => e.name), ['big.iso', 'Docs', 'Junction']);
  assert.equal(r.entries[2].link, true);
  assert.equal(r.entries[2].bytes, 0, 'links are never measured');
});

test('scan stops when cancelled and says so', async () => {
  const nodeSys = createNodeSys();
  setSys({
    ...nodeSys,
    readDir: async () => [
      { name: 'a.bin', dir: false, file: true, link: false },
      { name: 'b.bin', dir: false, file: true, link: false },
    ],
    stat: async () => ({ size: 1, dir: false, created: 0, modified: 0 }),
  });
  const r = await scan('C:\\Data', () => true);
  assert.equal(r.complete, false);
  assert.equal(r.entries.length, 0);
});

test('toText renders drives and a folder scan', () => {
  const text = toText({
    drives: [{ root: 'C:\\', used: 107374182400, free: 53687091200 }],
    scan: { path: 'C:\\', total: 2147483648, complete: true, entries: [{ name: 'Windows', dir: true, bytes: 2147483648, partial: false }] },
  });
  assert.match(text, /C:\\ {2}50\.00 GB free of 150\.00 GB/);
  assert.match(text, /Windows\\/);
  assert.match(text, /100\.0%/);
});

test('list returns files sized and folders pending, without measuring', async () => {
  const nodeSys = createNodeSys();
  let measured = 0;
  setSys({
    ...nodeSys,
    readDir: async () => [
      { name: 'Docs', dir: true, file: false, link: false },
      { name: 'big.iso', dir: false, file: true, link: false },
      { name: 'Junction', dir: true, file: false, link: true },
    ],
    stat: async () => ({ size: 2048 }),
    folderSize: async () => {
      measured++;
      return { bytes: 1, entries: 1, truncated: false };
    },
  });
  const r = await list('C:\\');
  const docs = r.entries.find((e) => e.name === 'Docs');
  const iso = r.entries.find((e) => e.name === 'big.iso');
  const junction = r.entries.find((e) => e.name === 'Junction');
  assert.equal(docs.pending, true, 'folders come back pending');
  assert.equal(iso.bytes, 2048, 'files carry their real size');
  assert.equal(junction.link, true, 'links stay unmeasured');
  assert.equal(measured, 0, 'listing never measures a folder');
});

test('measureFolders sizes folders and honours the stop flag', async () => {
  const nodeSys = createNodeSys();
  setSys({
    ...nodeSys,
    folderSize: async (p) => ({ bytes: p.length * 100, entries: 1, truncated: p.includes('Big') }),
  });
  const done = await measureFolders(['C:\\A', 'C:\\Big'], () => false);
  assert.equal(done.complete, true);
  assert.equal(done.measured.length, 2);
  assert.equal(done.measured.find((m) => m.path.endsWith('Big')).partial, true);
  const stopped = await measureFolders(['C:\\A', 'C:\\B'], () => true);
  assert.equal(stopped.complete, false);
  assert.equal(stopped.measured.length, 0);
});
