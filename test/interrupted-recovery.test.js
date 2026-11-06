import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setSys, sys } from '../src/backend/sys.js';
import * as backups from '../src/backend/backups.js';
import { recoveryLeaseFixture } from './recovery-lease-fixture.js';

// Entirely in-memory: no Windows commands, registry, disk or Recycle Bin access.
const root = 'C:\\MockRecovery';
const id = 'fixture';
const pendingPath = `${root}\\pending.json`;
const manifestPath = `${root}\\${id}\\manifest.json`;
const created = '2026-10-29T00:00:00.000Z';
const pending = () => ({ id, title: 'Fixture', started: created, owners: [], items: [{ kind: 'key', path: 'HKCU\\Software\\Fixture' }] });
const manifest = () => ({ id, title: 'Fixture', created, complete: false, entries: [] });
async function fixture({ p = pending(), m = manifest(), readError = '', failRestore = false, failClear = false, failWrite, committed = false } = {}) {
  const files = new Map([[pendingPath, typeof p === 'string' ? p : JSON.stringify(p)], [manifestPath, typeof m === 'string' ? m : JSON.stringify(m)]]);
  const calls = [];
  let writes = 0;
  const lease = recoveryLeaseFixture();
  setSys({
    ...lease,
    info: { dataDir: root, env: {} }, makeDir: async () => {}, stat: async () => null,
    exists: async (path) => { calls.push(['exists', path]); return files.has(path); },
    readText: async (path) => { calls.push(['read', path]); if (readError === path) throw new Error('Access denied'); if (!files.has(path)) throw new Error('Not found'); return files.get(path); },
    readOptionalText: async (path) => { calls.push(['read', path]); if (readError === path) throw new Error('Access denied'); return files.has(path) ? files.get(path) : null; },
    writeTextAtomic: async (path, value) => { calls.push(['write', path]); const failed = path === manifestPath && ++writes === failWrite; if (!failed || committed) files.set(path, value); if (failed) throw Error('Receipt denied'); },
    removePath: async (path) => { calls.push(['remove', path]); if (failClear && path === pendingPath) { if (committed) files.delete(path); throw new Error('Journal locked'); } files.delete(path); },
    readDir: async () => [{ name: id, dir: true }], trash: async (path) => { calls.push(['trash', path]); files.delete(path); }, folderSize: async () => ({ bytes: 100 }),
    sha256Files: async (paths) => paths.map(() => 'a'.repeat(64)),
    secretGet: async () => '', secretKeys: async () => [],
    exec: async (file, args, token) => { lease.assertRecoveryToken(token); calls.push(['exec', file, args]); return { ok: !failRestore, stderr: failRestore ? 'Denied' : '' }; },
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
  await assert.rejects(() => backups.resolveInterrupted('rollback'), /Journal locked/);
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

test('rollback guard and terminal receipt failures retain evidence across restart without replay', async () => {
  const m = { ...manifest(), entries: [{ kind: 'newkey', path: 'HKCU\\Software\\Fixture' }] };
  for (const failWrite of [1, 2]) for (const committed of [false, true]) {
    const { files, calls } = await fixture({ m, failWrite, committed });
    await assert.rejects(() => backups.resolveInterrupted('rollback'), /Receipt denied/);
    assert.equal(files.has(pendingPath), true);
    const dispatched = calls.filter(([kind]) => kind === 'exec').length;
    assert.equal(dispatched, failWrite === 1 ? 0 : 1);
    // Simulate restarting the process with the persisted manifest.
    const persisted = JSON.parse(files.get(manifestPath));
    const restarted = await fixture({ m: persisted });
    if (persisted.recovery?.status === 'completed') {
      assert.equal((await backups.resolveInterrupted('rollback')).alreadyCompleted, true);
      assert.equal(restarted.files.has(pendingPath), false);
    } else if (persisted.recovery) {
      await assert.rejects(() => backups.resolveInterrupted('rollback'), /earlier rollback/);
    }
    assert.equal(restarted.calls.some(([kind]) => kind === 'exec'), false);
  }
});

test('terminal receipt survives failed pending deletion and retry only clears pending', async () => {
  const m = { ...manifest(), entries: [{ kind: 'newkey', path: 'HKCU\\Software\\Fixture' }] };
  const { files, calls } = await fixture({ m, failClear: true });
  await assert.rejects(() => backups.resolveInterrupted('rollback'), /Journal locked/);
  const persisted = JSON.parse(files.get(manifestPath));
  assert.equal(persisted.recovery.status, 'completed');
  assert.ok(persisted.recovery.completed && persisted.fingerprint);
  assert.equal(calls.filter(([kind]) => kind === 'exec').length, 1);
  const restarted = await fixture({ m: persisted });
  assert.equal((await backups.resolveInterrupted('rollback')).alreadyCompleted, true);
  assert.equal(restarted.calls.some(([kind]) => kind === 'exec'), false);
  assert.equal(await backups.interrupted(), null);
  await assert.rejects(() => backups.restore(id), /manual review/);
  assert.equal(JSON.parse(restarted.files.get(manifestPath)).recovery.status, 'completed');
});

test('completed receipt rejects missing or changed fingerprint and unknown states', async () => {
  for (const recovery of [
    { action: 'rollback', status: 'completed', started: created, completed: created },
    { action: 'rollback', status: 'unknown', started: created },
  ]) {
    const { calls } = await fixture({ m: { ...manifest(), recovery } });
    await assert.rejects(() => backups.resolveInterrupted('rollback'), /invalid rollback/);
    assert.equal(calls.some(([kind]) => kind === 'exec' || kind === 'remove'), false);
  }
});

test('recycled cancellation respects dispatch boundaries and reports actual completed moves', async () => {
  const entries = ['first', 'second'].map(name => ({ kind: 'file', path: `C:\\Fixture\\${name}`, recycled: true }));
  for (const stopBefore of [true, false]) {
    await fixture({ m: { ...manifest(), complete: true, entries } });
    let stopped = stopBefore;
    const moved = [];
    setSys({ runPS: async (_script, input) => {
      const originals = JSON.parse(input); moved.push(...originals); stopped = true;
      return JSON.stringify(Object.fromEntries(originals.map(p => [p, 'OK'])));
    } });
    const result = await backups.restore(id, undefined, () => stopped);
    assert.deepEqual(moved, stopBefore ? [] : [entries[0].path]);
    assert.equal(result[0].ok, !stopBefore);
    assert.match(result[1].detail, /cancelled/);
    if (!stopBefore) assert.match(result[0].detail, /Restored from/);
  }
});

test('selective restore dispatches no excluded recycled entry; lost response reports uncertainty', async () => {
  const entries = [{ kind: 'file', path: 'C:\\Fixture\\first', recycled: true }, { kind: 'newkey', path: 'HKCU\\Software\\Fixture' }];
  await fixture({ m: { ...manifest(), complete: true, entries } });
  let calls = 0;
  setSys({ runPS: async () => { calls++; throw Error('Response lost after move'); } });
  assert.equal((await backups.restore(id, [1]))[0].ok, true);
  assert.equal(calls, 0);
  const result = await backups.restore(id, [0]);
  assert.equal(result[0].uncertain, true);
  assert.match(result[0].detail, /outcome uncertain/);
  assert.doesNotMatch(result[0].detail, /Left in place/);
});

test('busy or missing lease refuses all public mutation routes before reads or side effects', async () => {
  const { calls } = await fixture();
  const release = sys.releaseRecoveryLease;
  const token = await sys.acquireRecoveryLease();
  const routes = [() => backups.removeItems({ items: [] }), () => backups.restore(id), () => backups.resolveInterrupted('rollback'), () => backups.remove(id), () => backups.prune({ maxDays: 1 }), () => backups.restoreFromRecycleBin('C:\\Fixture\\file'), () => backups.restoreManyFromRecycleBin([])];
  for (const route of routes) await assert.rejects(route, /busy/);
  assert.deepEqual(calls, []);
  await release(token);
  setSys({ acquireRecoveryLease: undefined, releaseRecoveryLease: undefined });
  for (const route of routes) await assert.rejects(route, /capability unavailable/);
  assert.deepEqual(calls, []);
});

test('prune holds one lease through selection, hook and nested deletion', async () => {
  const m = { ...manifest(), complete: true, entries: [{ kind: 'newkey', path: 'HKCU\\Software\\Fixture' }] };
  const { files, calls } = await fixture({ m });
  files.delete(pendingPath);
  files.set(`${root}\\newest\\manifest.json`, JSON.stringify({ ...m, id: 'newest', created: '2026-11-01T00:00:00.000Z' }));
  setSys({ readDir: async (target) => target === root
    ? [{ name: id, dir: true }, { name: 'newest', dir: true }]
    : files.has(target + '\\manifest.json') ? [{ name: 'manifest.json', file: true, link: false }] : [] });
  let hookCalls = 0;
  const removed = await backups.prune({ maxDays: 1 }, Date.parse('2026-11-03'), { beforeFirstRemove: async () => {
    hookCalls++;
    await assert.rejects(() => backups.restore(id), /busy/);
    assert.equal(calls.some(([kind]) => kind === 'remove'), false);
  } });
  assert.deepEqual(removed, [id]);
  assert.equal(hookCalls, 1);
  assert.equal(calls.filter(([kind]) => kind === 'remove').length, 1);
  const token = await sys.acquireRecoveryLease();
  await sys.releaseRecoveryLease(token);
});

test('failed release is retried once before concurrent public operations acquire fresh leases', async () => {
  const { files, calls } = await fixture({ p: '{broken' });
  const original = files.get(pendingPath);
  const acquire = sys.acquireRecoveryLease;
  const release = sys.releaseRecoveryLease;
  let closed = false;
  let cleanupGate;
  let continueCleanup;
  let releases = 0;
  const tokens = [];
  setSys({
    acquireRecoveryLease: async () => { const token = await acquire(); tokens.push(token); return token; },
    releaseRecoveryLease: async (token) => {
      releases++;
      if (!closed) throw Error('Job still active; lease retained');
      if (cleanupGate) await cleanupGate;
      await release(token);
    },
  });
  await assert.rejects(() => backups.resolveInterrupted('keep'), error => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.errors[0].message, /retained/);
    assert.match(error.errors[1].message, /Job still active/);
    return true;
  });
  calls.length = 0;
  await assert.rejects(() => backups.remove(id), /Job still active/);
  assert.deepEqual(calls, []);
  assert.equal(tokens.length, 1);
  closed = true;
  cleanupGate = new Promise(resolve => { continueCleanup = resolve; });
  const first = backups.remove(id);
  const second = backups.prune({ maxDays: 1 });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(releases, 3);
  assert.equal(tokens.length, 1);
  assert.deepEqual(calls, []);
  continueCleanup();
  const results = await Promise.allSettled([first, second]);
  assert.ok(results.every(result => result.status === 'rejected'));
  assert.ok(results.some(result => /busy/.test(result.reason.message)));
  assert.equal(tokens.length, 2);
  assert.notEqual(tokens[0], tokens[1]);
  assert.equal(files.get(pendingPath), original);
  assert.equal(calls.some(([kind]) => ['write', 'remove', 'trash', 'exec'].includes(kind)), false);
  // A later request reaches journal validation with another fresh lease.
  await assert.rejects(() => backups.prune({ maxDays: 1 }), /retained/);
  assert.equal(tokens.length, 3);
});

test('successful operation preserves a refused release until closure and public retry', async () => {
  const { files } = await fixture();
  const original = files.get(pendingPath);
  const release = sys.releaseRecoveryLease;
  let closed = false;
  setSys({ releaseRecoveryLease: async token => {
    if (!closed) throw Error('Release refused');
    await release(token);
  } });
  await assert.rejects(() => backups.prune({ maxDays: 1 }), /Release refused/);
  assert.equal(files.get(pendingPath), original);
  closed = true;
  assert.deepEqual(await backups.prune({ maxDays: 1 }), []);
  assert.equal(files.get(pendingPath), original);
});

test('completed rollback can be removed after pending is cleared; changed receipt cannot clear evidence', async () => {
  const m = { ...manifest(), entries: [{ kind: 'newkey', path: 'HKCU\\Software\\Fixture' }] };
  const { files, calls } = await fixture({ m });
  await backups.resolveInterrupted('rollback');
  const sealed = JSON.parse(files.get(manifestPath));
  await backups.remove(id);
  assert.equal(calls.filter(([kind]) => kind === 'trash').length, 1);
  const restarted = await fixture({ m: { ...sealed, recovery: { ...sealed.recovery, completed: 'tampered' } } });
  await assert.rejects(() => backups.resolveInterrupted('rollback'), /changed after/);
  assert.equal(restarted.files.has(pendingPath), true);
  assert.equal(restarted.calls.some(([kind]) => kind === 'exec' || kind === 'remove'), false);
});

test('pending deletion committed before rejection leaves a terminal receipt and no replay path', async () => {
  const m = { ...manifest(), entries: [{ kind: 'newkey', path: 'HKCU\\Software\\Fixture' }] };
  const { files, calls } = await fixture({ m, failClear: true, committed: true });
  await assert.rejects(() => backups.resolveInterrupted('rollback'), /Journal locked/);
  assert.equal(files.has(pendingPath), false);
  assert.equal(JSON.parse(files.get(manifestPath)).recovery.status, 'completed');
  assert.equal(await backups.interrupted(), null);
  assert.deepEqual((await backups.resolveInterrupted('rollback')).results, []);
  await assert.rejects(() => backups.restore(id), /manual review/);
  assert.equal(calls.filter(([kind]) => kind === 'exec').length, 1);
});

test('malformed or missing recycled helper response is uncertain rather than untouched', async () => {
  const m = { ...manifest(), complete: true, entries: [{ kind: 'file', path: 'C:\\Fixture\\file', recycled: true }] };
  for (const response of ['invalid json', '{}', 'null']) {
    await fixture({ m });
    setSys({ runPS: async () => response });
    const result = await backups.restore(id);
    assert.equal(result[0].ok, false);
    assert.equal(result[0].uncertain, true);
    assert.match(result[0].detail, /uncertain/);
  }
});
