import test from 'node:test';
import assert from 'node:assert/strict';
import { setSys } from '../src/backend/sys.js';
import * as transfer from '../src/backend/transfer.js';

const root = 'C:\\IdentityRestore', id = '456';
const target = 'C:\\Users\\IdentityTester\\AppData\\Roaming\\Fixture\\settings.ini';
const receipt = () => ({ version: 1, target, sid: 'S-1-5-21-1', machine: 'fixture', infoName: '$Ioriginal.ini', infoSha256: 'a'.repeat(64), identity: { volume: 1, high: 2, low: 3 }, directory: false, digest: 'b'.repeat(64) });
const journal = () => ({ id, complete: true, pending: [], dirs: [], files: [target], keys: [], values: [], replaced: [target], replacementReceipts: [receipt()] });

test('replacement undo restores original A despite newer same-path imported B in the Recycle Bin', async () => {
  let current = 'imported B';
  const bin = ['original A'], saved = journal();
  setSys({ info: { dataDir: root, home: 'C:\\Users\\IdentityTester', env: { LOCALAPPDATA: 'C:\\Users\\IdentityTester\\AppData\\Local' } },
    makeDir: async () => {}, readText: async () => JSON.stringify(saved), exists: async () => current !== null,
    trash: async () => { bin.push(current); current = null; },
    validateTransferReplacement: async () => {},
    restoreTransferReplacement: async () => { assert.equal(current, null); current = bin[0]; return { restored: true }; },
    runPS: async () => { current = bin.at(-1); return JSON.stringify({ [target]: 'OK' }); },
  });
  await transfer.setRoot(root);
  const result = await transfer.undo(id);
  assert.ok(result.every((entry) => entry.ok));
  assert.equal(current, 'original A');
});

async function undoFixture(saved = journal(), options = {}) {
  const calls = [], files = new Map([[`${root}\\${id}\\restore.json`, JSON.stringify(saved)]]);
  let current = options.absent ? null : 'imported B';
  setSys({ info: { dataDir: root, home: 'C:\\Users\\IdentityTester', env: { LOCALAPPDATA: 'C:\\Users\\IdentityTester\\AppData\\Local' } },
    makeDir: async () => {}, readText: async (path) => files.get(path), exists: async () => current !== null,
    trash: async (path) => { calls.push(['trash', path]); if (options.trashFail) throw Error('trash denied'); if (!options.stillPresent) current = null; },
    validateTransferReplacement: async (path, value) => { calls.push(['validate', path, value]); if (options.validateFail === path) throw Error('exact original missing or changed'); },
    restoreTransferReplacement: async (path, value) => { calls.push(['restore', path, value]); if (options.restoreFail) throw Error('destination conflict'); assert.equal(current, null); current = 'original A'; return options.unconfirmed ? {} : { restored: true }; },
    runPS: async () => { throw Error('Newest-path Recycle Bin fallback is forbidden'); },
    writeTextAtomic: async () => { throw Error('Undo must retain evidence'); }, removePath: async () => { throw Error('Undo must retain evidence'); },
  });
  await transfer.setRoot(root);
  return { calls, files, current: () => current };
}

test('legacy ambiguous and malformed replacement receipts refuse before any mutation', async () => {
  for (const mutate of [r => delete r.replacementReceipts, r => r.replacementReceipts = [], r => r.replacementReceipts = {}, r => r.replacementReceipts.push(receipt()),
    r => r.replacementReceipts[0].version = 2, r => r.replacementReceipts[0].target += 'other', r => r.replacementReceipts[0].directory = true,
    r => r.replacementReceipts[0].infoName = '..\\$Ibad', r => r.replacementReceipts[0].infoName = '$Ibad.', r => r.replacementReceipts[0].digest = 'bad',
    r => r.replacementReceipts[0].identity.low = -1, r => r.replacementReceipts[0].unexpected = true, r => r.replacementReceipts[0].identity.extra = true,
    r => r.files.push(target + '\\child')]) {
    const saved = journal(); mutate(saved); const f = await undoFixture(saved);
    await assert.rejects(transfer.undo(id)); assert.equal(f.calls.some(([kind]) => kind !== 'validate'), false);
    assert.equal(f.current(), 'imported B'); assert.equal(f.files.size, 1);
  }
});

test('every exact receipt is checked before even the first imported copy is trashed', async () => {
  const second = target.replace('settings.ini', 'other.ini');
  const saved = journal(); saved.files.push(second); saved.replaced.push(second); saved.replacementReceipts.push({ ...receipt(), target: second, infoName: '$Iother.ini', identity: { volume: 1, high: 2, low: 4 } });
  const f = await undoFixture(saved, { validateFail: second });
  await assert.rejects(transfer.undo(id), /missing or changed/);
  assert.deepEqual(f.calls.map(([kind]) => kind), ['validate', 'validate']); assert.equal(f.current(), 'imported B');
});

test('missing current copy restores exact original without trash and directory receipts keep their kind', async () => {
  for (const directory of [false, true]) {
    const saved = journal(); saved.replacementReceipts[0].directory = directory;
    if (directory) { saved.dirs = saved.files; saved.files = []; }
    const f = await undoFixture(saved, { absent: true });
    const result = await transfer.undo(id); assert.ok(result.every((entry) => entry.ok)); assert.equal(f.current(), 'original A');
    assert.deepEqual(f.calls.map(([kind]) => kind), ['validate', 'restore']);
  }
});

test('split native file identity preserves all uint32 bits after journal reload', async () => {
  const saved = journal(); saved.replacementReceipts[0].identity = { volume: 0xffffffff, high: 0xffffffff, low: 0xffffffff };
  const f = await undoFixture(saved, { absent: true }); await transfer.undo(id);
  assert.deepEqual(f.calls.find(([kind]) => kind === 'restore')[2].identity, saved.replacementReceipts[0].identity);
});

test('trash, destination conflict and unconfirmed exact restore never report recovery success', async () => {
  for (const options of [{ trashFail: true }, { stillPresent: true }, { restoreFail: true }, { unconfirmed: true }]) {
    const f = await undoFixture(journal(), options); const result = await transfer.undo(id);
    assert.equal(result.at(-1).ok, false); assert.equal(f.files.size, 1);
    if (options.trashFail || options.stillPresent) assert.equal(f.calls.some(([kind]) => kind === 'restore'), false);
  }
});

async function restoreFixture(options = {}) {
  const calls = [], files = new Map(); let current = 'original A';
  const manifest = { format: 'purgeon-program-backup', version: 1, source: { profile: 'C:\\Users\\IdentityTester' }, program: { name: 'Fixture' }, items: [{ n: 0, kind: options.directory ? 'dir' : 'file', path: target, ...(options.skip ? { skip: true } : {}) }] };
  setSys({ info: { dataDir: root, home: 'C:\\Users\\IdentityTester', env: { LOCALAPPDATA: 'C:\\Users\\IdentityTester\\AppData\\Local' } },
    makeDir: async () => {}, exists: async (path) => path === 'C:\\' || path === target && current !== null,
    readText: async (path) => files.get(path),
    writeTextAtomic: async (path, text) => { const record = JSON.parse(text); calls.push(['checkpoint', structuredClone(record)]); if (options.persistFail && record.replacementReceipts.length && !record.inFlight) throw Error('receipt checkpoint denied'); files.set(path, text); },
    captureTransferReplacement: async (path, directory) => { calls.push(['capture', path, directory]); if (options.captureFail) throw Error('capture denied'); current = null; return { ...receipt(), directory }; },
    runPS: async (script, input) => {
      if (script.includes("GetEntry('manifest.json')")) return JSON.stringify(manifest);
      const request = JSON.parse(input); if (request.preflight) return '{}';
      calls.push(['extract', request]);
      if (options.extractFail) return JSON.stringify({ 0: 'EXISTS' });
      if (request.items.length) current = 'imported B';
      return JSON.stringify(Object.fromEntries(request.items.map((entry) => [entry.n, 'OK 1'])));
    },
    validateTransferReplacement: async (path, value) => { calls.push(['validate', path, value]); },
    restoreTransferReplacement: async () => { current = 'original A'; return { restored: true }; },
    trash: async () => { current = null; },
  });
  await transfer.setRoot(root);
  return { calls, files, current: () => current, run: () => transfer.restore('C:\\Fixture.swpkg', [0], { replace: true }) };
}

test('restore checkpoints exact receipt before extraction and undo reloads the persisted original identity', async () => {
  for (const directory of [false, true]) {
    const f = await restoreFixture({ directory }); const result = await f.run();
    const extract = f.calls.findIndex(([kind]) => kind === 'extract');
    assert.ok(f.calls.slice(0, extract).some(([kind, record]) => kind === 'checkpoint' && record.replacementReceipts.length === 1 && !record.inFlight));
    const saved = JSON.parse([...f.files.values()][0]); assert.equal(saved.complete, true); assert.equal(saved.replacementReceipts[0].directory, directory);
    assert.equal(f.current(), 'imported B'); assert.ok((await transfer.undo(result.id)).every((entry) => entry.ok)); assert.equal(f.current(), 'original A');
  }
});

test('capture or receipt checkpoint failure stops before extraction and retains incomplete recovery journal', async () => {
  for (const options of [{ captureFail: true }, { persistFail: true }]) {
    const f = await restoreFixture(options); await assert.rejects(f.run(), /did not complete/);
    assert.equal(f.calls.some(([kind]) => kind === 'extract'), false);
    const saved = JSON.parse([...f.files.values()][0]); assert.equal(saved.complete, false); assert.equal(saved.inFlight.kind, 'replace');
  }
});

test('failed replaced extraction retains incomplete in-flight evidence instead of sealing success', async () => {
  const f = await restoreFixture({ extractFail: true }); await assert.rejects(f.run(), /extraction did not complete/);
  const saved = JSON.parse([...f.files.values()][0]); assert.equal(saved.complete, false); assert.equal(saved.inFlight.kind, 'extract'); assert.equal(saved.replacementReceipts.length, 1);
});

test('package skip metadata cannot displace an original that extraction will skip', async () => {
  const f = await restoreFixture({ skip: true }); await f.run();
  assert.equal(f.calls.some(([kind]) => kind === 'capture'), false); assert.equal(f.current(), 'original A');
});
