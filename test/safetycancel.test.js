// Safety-standard tests: long operations can be cancelled between steps, and
// deleting Purgeon's own data (backups, snapshots) goes to the Recycle Bin
// instead of a hard delete. Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setSys } from '../src/backend/sys.js';
import { createNodeSys } from './node-sys.js';
import * as backups from '../src/backend/backups.js';
import * as snapshots from '../src/backend/snapshots.js';
import { cleanSystem } from '../src/backend/junk.js';
import { diskMap } from '../src/backend/explore.js';

// The backend speaks Windows paths everywhere; on this machine the fake sys
// translates them to real paths for the filesystem calls it makes itself.
const toReal = (p) => String(p).replace(/\\/g, '/');
const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'purgeon-bin-'));
const trashedTo = [];
const nodeSys = createNodeSys();
setSys({
  ...nodeSys,
  exists: async (p) => fs.existsSync(toReal(p)) || /^C:\\Temp\\/i.test(String(p)),
  trash: async (p) => {
    trashedTo.push(p);
    const real = toReal(p);
    if (fs.existsSync(real)) fs.renameSync(real, path.join(bin, `${Date.now()}-${path.basename(real)}`));
  },
  trashMany: undefined,
});

const noState = { programs: [], shared: [] };
// Windows-style paths: real-looking install folders that no guard protects.
const mkDirItem = (n) => ({ kind: 'dir', path: `C:\\Temp\\PurgeonItem${n}` });

test('removeItems stops between items when cancelled and seals what it removed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'purgeon-backups-'));
  await backups.setRoot(root);
  const items = [mkDirItem(1), mkDirItem(2), mkDirItem(3)];
  let stop = false;
  const moved = [];
  const r = await backups.removeItems({
    title: 'cancel test',
    items,
    state: noState,
    trashItem: async (p) => {
      moved.push(p);
      stop = true; // the user cancels while the first item is being removed
    },
    shouldStop: () => stop,
  });
  assert.equal(r.cancelled, true);
  assert.equal(moved.length, 1, 'only the first item was removed');
  assert.equal(r.results.length, 3, 'every item is reported');
  assert.equal(r.results[0].ok, true);
  assert.match(r.results[1].detail, /Left in place/);
  assert.match(r.results[2].detail, /Left in place/);
  assert.ok(r.backupId, 'the partial removal still sealed a backup');
  fs.rmSync(root, { recursive: true, force: true });
});

test('removeItems without cancellation removes everything and reports no cancel', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'purgeon-backups-'));
  await backups.setRoot(root);
  const items = [mkDirItem(1), mkDirItem(2)];
  const moved = [];
  const r = await backups.removeItems({ title: 'full test', items, state: noState, trashItem: async (p) => moved.push(p) });
  assert.equal(r.cancelled, false);
  assert.equal(moved.length, 2);
  assert.ok(r.results.every((x) => x.ok));
  fs.rmSync(root, { recursive: true, force: true });
});

test('deleting a backup sends its folder to the Recycle Bin', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'purgeon-backups-'));
  await backups.setRoot(root);
  const id = '2026-01-01_test-backup';
  fs.mkdirSync(path.join(root, id));
  fs.writeFileSync(path.join(root, id, 'manifest.json'), '{}');
  trashedTo.length = 0;
  await backups.remove(id);
  assert.equal(trashedTo.length, 1);
  assert.ok(trashedTo[0].endsWith(id), 'the backup folder itself was trashed');
  assert.ok(!fs.existsSync(path.join(root, id)), 'gone from the backup store');
  assert.ok(fs.readdirSync(bin).some((f) => f.endsWith(id)), 'recoverable from the bin');
  fs.rmSync(root, { recursive: true, force: true });
});

test('deleting a snapshot sends both of its files to the Recycle Bin', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'purgeon-snaps-'));
  await snapshots.setRoot(root);
  fs.writeFileSync(path.join(root, '123.snap'), 'data');
  fs.writeFileSync(path.join(root, '123.json'), '{}');
  trashedTo.length = 0;
  await snapshots.remove('123');
  assert.equal(trashedTo.length, 2);
  assert.ok(!fs.existsSync(path.join(root, '123.snap')));
  assert.ok(!fs.existsSync(path.join(root, '123.json')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('diskMap stops early when cancelled and returns what it has', async () => {
  const programs = [{ key: 'k1', name: 'Foo Editor', publisher: 'Contoso', location: '' }];
  const out = await diskMap(programs, () => true);
  assert.deepEqual(out, []);
});

test('cleanSystem reports un-run options as cancelled when stopped', async () => {
  const results = await cleanSystem(['winsxs', 'windowsold'], () => true);
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => !r.ok && r.detail === 'Cancelled'));
});

test('snapshot take and compare stop calmly when cancelled', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'purgeon-snapcancel-'));
  let mode = 'cancel';
  let metaWrites = 0;
  setSys({
    ...nodeSys,
    takeSnapshot: async () => {
      if (mode === 'cancel') throw new Error('cancelled');
      return { dirs: 1, files: 2, keys: 3, values: 4, ms: 5, bytes: 6 };
    },
    compareSnapshots: async () => {
      if (mode === 'cancel') throw new Error('cancelled');
      return { added: [], removed: [], changed: [], truncated: false };
    },
    cancelSnapshot: async () => {},
    writeTextAtomic: async (p, s) => {
      metaWrites++;
      return nodeSys.writeTextAtomic(p, s);
    },
  });
  await snapshots.setRoot(dir);
  const cancelledTake = await snapshots.take('Test', 'quick');
  assert.deepEqual(cancelledTake, { cancelled: true }, 'a cancelled take reports cancelled, not an error');
  assert.equal(metaWrites, 0, 'a cancelled take saves no snapshot record');
  mode = 'ok';
  const meta = await snapshots.take('Test', 'quick');
  assert.ok(meta.id && metaWrites === 1, 'a normal take still works');
  mode = 'cancel';
  const cancelledCompare = await snapshots.compare(meta.id, meta.id);
  assert.deepEqual(cancelledCompare, { cancelled: true }, 'a cancelled compare reports cancelled, not an error');
  fs.rmSync(dir, { recursive: true, force: true });
});
