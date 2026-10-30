import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setSys } from '../src/backend/sys.js';
import * as backups from '../src/backend/backups.js';

// Entirely in-memory: no Windows commands, registry, disk or Recycle Bin access.
const root = 'C:\\MockRecovery';
const id = 'fixture';
const pendingPath = `${root}\\pending.json`;
const manifestPath = `${root}\\${id}\\manifest.json`;
const created = '2026-10-29T00:00:00.000Z';
const pending = () => ({ id, title: 'Fixture', started: created, owners: [], items: [{ kind: 'key', path: 'HKCU\\Software\\Fixture' }] });
const manifest = () => ({ id, title: 'Fixture', created, complete: false, entries: [] });
async function fixture({ p = pending(), m = manifest(), readError = '', failRestore = false, failClear = false } = {}) {
  const files = new Map([[pendingPath, typeof p === 'string' ? p : JSON.stringify(p)], [manifestPath, typeof m === 'string' ? m : JSON.stringify(m)]]);
  const calls = [];
  setSys({
    info: { dataDir: root, env: {} }, makeDir: async () => {}, stat: async () => null,
    exists: async (path) => { calls.push(['exists', path]); return files.has(path); },
    readText: async (path) => { calls.push(['read', path]); if (readError === path) throw new Error('Access denied'); if (!files.has(path)) throw new Error('Not found'); return files.get(path); },
    readOptionalText: async (path) => { calls.push(['read', path]); if (readError === path) throw new Error('Access denied'); return files.has(path) ? files.get(path) : null; },
    writeTextAtomic: async (path, value) => { calls.push(['write', path]); files.set(path, value); },
    removePath: async (path) => { calls.push(['remove', path]); if (failClear && path === pendingPath) throw new Error('Journal locked'); files.delete(path); },
    readDir: async () => [{ name: id, dir: true }], trash: async (path) => { calls.push(['trash', path]); files.delete(path); }, folderSize: async () => ({ bytes: 100 }),
    sha256Files: async (paths) => paths.map(() => 'a'.repeat(64)),
    secretGet: async () => '', secretKeys: async () => [],
    exec: async (file, args) => { calls.push(['exec', file, args]); return { ok: !failRestore, stderr: failRestore ? 'Denied' : '' }; },
    runPS: async () => { throw new Error('Unexpected PowerShell'); },
  });
  await backups.setRoot(root);
  return { files, calls };
}

test('invalid recovery action and dismiss do not read or change evidence', async () => {
  const { files, calls } = await fixture();
  await assert.rejects(() => backups.resolveInterrupted('typo'), /Invalid recovery action/);
  assert.equal((await backups.resolveInterrupted('dismiss')).retained, true);
  assert.deepEqual(calls, []);
  assert.equal(files.size, 2);
});

test('absent pending record is distinct from unreadable or corrupt evidence', async () => {
  const absent = await fixture();
  absent.files.delete(pendingPath);
  assert.equal(await backups.interrupted(), null);
  for (const options of [{ p: '{broken' }, { p: { ...pending(), id: '../outside' } }, { p: { ...pending(), items: null } }, { readError: pendingPath }]) {
    const { files, calls } = await fixture(options);
    assert.equal((await backups.interrupted()).reviewRequired, true);
    await assert.rejects(() => backups.resolveInterrupted('keep'), /retained/);
    assert.equal(files.has(pendingPath), true);
    assert.equal(calls.some(([kind, path]) => kind === 'read' && path === manifestPath), false);
    assert.equal(calls.some(([kind]) => kind === 'write' || kind === 'remove' || kind === 'exec'), false);
  }
});

test('missing, unreadable, encrypted, malformed and invalid manifests retain evidence', async () => {
  const variants = [{ m: '{broken' }, { readError: manifestPath }, { m: 'PURGEON-ENC1:bad' }, { m: { ...manifest(), id: 'other' } }, { m: { ...manifest(), entries: null } }, { m: { ...manifest(), entries: [{ kind: 'key', path: 'HKCU\\Software\\Fixture', file: '../bad.reg' }] } }, { m: { ...manifest(), inFlight: null } }];
  for (const options of [{ missing: true }, ...variants]) {
    const { files, calls } = await fixture(options);
    if (options.missing) files.delete(manifestPath);
    assert.equal((await backups.interrupted()).reviewRequired, true);
    for (const action of ['keep', 'rollback', 'finish']) await assert.rejects(() => backups.resolveInterrupted(action), /retained/);
    assert.equal(files.has(pendingPath), true);
    assert.equal(calls.some(([kind]) => kind === 'write' || kind === 'remove' || kind === 'exec'), false);
  }
});

test('uncertain and unreconciled operations cannot be automatically replayed', async () => {
  const intent = { kind: 'key', path: 'HKCU\\Software\\Fixture', file: 'key.reg', intentId: 0, recorded: created };
  const uncertain = await fixture({ m: { ...manifest(), entries: [], intents: [intent], inFlight: intent } });
  assert.equal((await backups.interrupted()).reviewRequired, true);
  await assert.rejects(() => backups.resolveInterrupted('rollback'), /uncertain/);
  assert.equal(uncertain.files.has(pendingPath), true);
  const clean = await fixture();
  await assert.rejects(() => backups.resolveInterrupted('finish'), /remaining item identities/);
  assert.equal(clean.files.has(pendingPath), true);
});

test('only proven empty backups are cleared', async () => {
  const clean = await fixture();
  await backups.resolveInterrupted('keep');
  assert.equal(clean.files.has(pendingPath), false);
  const inconsistent = await fixture({ m: { ...manifest(), intents: [{ kind: 'newkey', path: 'HKCU\\Software\\Fixture', intentId: 0, recorded: created, status: 'completed' }] } });
  await assert.rejects(() => backups.resolveInterrupted('keep'), /operation evidence|no recovery entry/);
  assert.equal(inconsistent.files.has(pendingPath), true);
});

test('rollback retains journal on partial failure and clears it only after successful restore', async () => {
  const m = { ...manifest(), entries: [{ kind: 'key', path: 'HKCU\\Software\\Fixture', file: 'key.reg' }] };
  for (const failRestore of [true, false]) {
    const { files, calls } = await fixture({ m, failRestore });
    const result = await backups.resolveInterrupted('rollback');
    assert.equal(files.has(pendingPath), failRestore);
    assert.equal(result.results[0].ok, !failRestore);
    const write = calls.findIndex(([kind]) => kind === 'write');
    const restore = calls.findIndex(([kind]) => kind === 'exec');
    const clear = calls.findIndex(([kind, path]) => kind === 'remove' && path === pendingPath);
    assert.ok(write >= 0 && restore > write);
    if (failRestore) {
      assert.equal(result.reviewRequired, true);
      const priorExecs = calls.filter(([kind]) => kind === 'exec').length;
      await assert.rejects(() => backups.resolveInterrupted('rollback'), /earlier rollback/);
      assert.equal(calls.filter(([kind]) => kind === 'exec').length, priorExecs);
    }
    else assert.ok(clear > restore);
  }
});

test('nonempty backup with orphan or unresolved intent is retained', async () => {
  const completed = { kind: 'newkey', path: 'HKCU\\Software\\Fixture', intentId: 0, recorded: created, status: 'completed' };
  const unresolved = { kind: 'newkey', path: 'HKCU\\Software\\Other', intentId: 1, recorded: created };
  for (const status of [undefined, 'completed']) {
    const { calls, files } = await fixture({ m: { ...manifest(), entries: [completed], intents: [completed, { ...unresolved, ...(status ? { status } : {}) }] } });
    await assert.rejects(() => backups.resolveInterrupted('keep'), /retained/);
    assert.equal(files.has(pendingPath), true);
    assert.equal(calls.some(([kind]) => kind === 'write' || kind === 'remove' || kind === 'exec'), false);
  }
});

test('journal-clear failure retains rollback guard and public restore cannot bypass it', async () => {
  const m = { ...manifest(), entries: [{ kind: 'newkey', path: 'HKCU\\Software\\Fixture' }] };
  const { calls, files } = await fixture({ m, failClear: true });
  await assert.rejects(() => backups.resolveInterrupted('rollback'), /Journal locked/);
  const mutations = calls.filter(([kind]) => kind === 'exec').length;
  assert.equal(mutations, 1);
  assert.equal(files.has(pendingPath), true);
  await assert.rejects(() => backups.resolveInterrupted('rollback'), /earlier rollback/);
  await assert.rejects(() => backups.restore(id), /manual review/);
  assert.equal(calls.filter(([kind]) => kind === 'exec').length, mutations);
});

test('manual deletion and pruning cannot bypass pending or rollback evidence', async () => {
  for (const options of [{}, { p: '{broken' }, { m: { ...manifest(), recovery: { action: 'rollback', status: 'in-progress', started: created } } }]) {
    const { calls, files } = await fixture(options);
    await assert.rejects(() => backups.remove(id), /retained/);
    if (typeof options.p === 'string') await assert.rejects(() => backups.prune({ maxDays: 1 }), /retained/);
    else await backups.prune({ maxDays: 1 });
    assert.equal(files.has(manifestPath), true);
    assert.equal(calls.some(([kind]) => kind === 'remove' || kind === 'trash'), false);
  }
  const { files, calls } = await fixture({ m: { ...manifest(), recovery: { action: 'rollback', status: 'in-progress', started: created } } });
  files.delete(pendingPath);
  await assert.rejects(() => backups.remove(id), /unfinished recovery evidence/);
  assert.equal(calls.some(([kind]) => kind === 'trash'), false);
});
