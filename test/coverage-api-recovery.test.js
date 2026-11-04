import test, { before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as leftovers from '../packages/purgeon-core/src/features/leftovers.js';
import * as backups from '../packages/purgeon-core/src/features/backups.js';
import * as history from '../packages/purgeon-core/src/features/history.js';
import { api } from '../src/backend/api.js';
import { createCoverageApiFixture } from './coverage-api-fixture.js';

let f;
before(async () => { f = await createCoverageApiFixture(); });
beforeEach(async () => { await f.reset(); });
afterEach(async () => { await f.flush(); assert.equal(f.held(), false); });
const item = name => ({ kind: 'file', path: `C:\\CoverageApiTemp\\${name}` });
const remove = items => leftovers.remove({ title: 'Coverage API removal', items, owners: [] });
const seed = (...items) => items.forEach(value => f.present.add(value.path));
const mutations = () => f.calls.filter(([kind]) => ['trash', 'restore'].includes(kind));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const interruptCompleted = id => {
  const manifest = f.manifest(id);
  manifest.complete = false; delete manifest.fingerprint;
  f.files.set(f.manifestPath(id), JSON.stringify(manifest));
  f.files.set(f.pendingPath, JSON.stringify({ id, title: manifest.title, started: manifest.created,
    items: manifest.entries.map(({ kind, path }) => ({ kind, path })), owners: [] }));
};

test('approved application removal persists a sealed package and history, then restores through the public facade', async () => {
  const selected = item('round-trip'); seed(selected);
  const result = await remove([selected]);
  assert.equal(result.results[0].ok, true);
  assert.deepEqual(result.restorePoint, { created: false, skipped: true });
  assert.equal(f.present.has(selected.path), false);
  assert.equal(f.recycled.has(selected.path), true);
  assert.equal(f.files.has(f.pendingPath), false);
  const manifest = f.manifest(result.backupId);
  assert.equal(manifest.complete, true);
  assert.equal(manifest.intents[0].status, 'completed');
  assert.equal(manifest.entries[0].path, selected.path);
  assert.match(manifest.fingerprint, /^[a-f0-9]{64}$/);
  const recorded = await history.list();
  assert.equal(recorded.length, 1);
  assert.deepEqual(recorded[0].undo, { channel: 'backups:restore', arg: result.backupId });
  const restored = await backups.restore(result.backupId);
  assert.equal(restored[0].ok, true);
  assert.equal(f.present.has(selected.path), true);
  assert.equal((await history.list())[0].detail, '1 of 1 entries restored');
  assert.deepEqual(f.approvals.map(request => request.channel), ['items:remove', 'history:list', 'backups:restore', 'history:list']);
});

test('failed initial checkpoint admits no deletion or success history and releases both guards', async () => {
  const selected = item('backup-denied'); seed(selected);
  f.control.write = path => { if (path.endsWith('manifest.json')) throw Error('fixture write denied'); };
  await assert.rejects(remove([selected]), /Recovery checkpoint.*fixture write denied/);
  assert.deepEqual(mutations(), []);
  assert.equal(f.present.has(selected.path), true);
  assert.deepEqual(await history.list(), []);
  delete f.control.write;
  assert.equal((await remove([selected])).results[0].ok, true);
});

test('corrupt pending evidence blocks real removal before storage writes and is retained byte-for-byte', async () => {
  const selected = item('pending'); seed(selected);
  f.files.set(f.pendingPath, '{retained damaged evidence');
  const before = [...f.files];
  await assert.rejects(remove([selected]), /Recovery needs review/);
  assert.deepEqual([...f.files], before);
  assert.deepEqual(mutations(), []);
  assert.equal((await backups.interrupted()).reviewRequired, true);
  assert.deepEqual(await history.list(), []);
});

test('fresh ownership and modification checks reject stale scan selections without deleting them', async () => {
  const owned = item('owned'), changed = { ...item('changed'), seen: 10 };
  seed(owned, changed);
  f.control.inventory = { programs: [{ key: 'HKCU\\Software\\Other', name: 'Other program', location: owned.path }], shared: [] };
  f.control.stat = path => path === changed.path ? { modified: 3011 } : null;
  const result = await remove([owned, changed]);
  assert.equal(result.backupId, null);
  assert.match(result.results[0].detail, /Used by Other program/);
  assert.match(result.results[1].detail, /Changed since the scan/);
  assert.deepEqual(mutations(), []);
  assert.equal(f.present.size, 2);
  assert.deepEqual(await history.list(), []);
});

test('cancellation remains available while real removal holds admission and seals only completed items', async () => {
  const first = item('cancel-first'), second = item('cancel-second'); seed(first, second);
  const entered = deferred(), release = deferred();
  f.control.trash = async () => { entered.resolve(); await release.promise; };
  const running = remove([first, second]);
  try {
    await entered.promise;
    await assert.rejects(backups.remove('other'), /in progress/);
    assert.equal((await api.invoke('settings:get')).createRestorePoints, false);
    assert.equal((await api.invoke('backups:interrupted')).reviewRequired, true);
    await leftovers.removeCancel();
  } finally { release.resolve(); }
  const result = await running;
  assert.equal(result.cancelled, true);
  assert.equal(result.results[0].ok, true);
  assert.match(result.results[1].detail, /cancelled/);
  assert.equal(f.present.has(second.path), true);
  assert.equal(f.manifest(result.backupId).entries.length, 1);
  assert.equal(f.manifest(result.backupId).complete, true);
  assert.equal(f.files.has(f.pendingPath), false);
  assert.equal((await history.list())[0].title, 'Removed 1 item: Coverage API removal');
});

test('uncertain completion never retries deletion or records success and blocks later removal', async () => {
  const first = item('uncertain-first'), second = item('uncertain-second'); seed(first, second);
  let writes = 0;
  f.control.write = path => { if (path.endsWith('manifest.json') && ++writes === 3) throw Error('registry locked after dispatch'); };
  const result = await remove([first, second]);
  assert.equal(result.interrupted, true);
  assert.equal(result.recoveryRequired, true);
  assert.equal(writes, 3, 'No automatic checkpoint retry');
  assert.deepEqual(mutations(), [['trash', first.path]]);
  assert.equal(f.present.has(second.path), true);
  assert.equal(f.manifest(result.backupId).inFlight.path, first.path);
  assert.deepEqual(await history.list(), []);
  const retained = [...f.files];
  await assert.rejects(remove([second]), /interrupted removal requires review/);
  await assert.rejects(backups.resolveInterrupted('finish'), /uncertain file/);
  await assert.rejects(backups.restore(result.backupId), /uncertain mutation/);
  assert.deepEqual([...f.files], retained);
  assert.deepEqual(mutations(), [['trash', first.path]]);
});

test('explicit keep resolves an interrupted package without replaying its original selection', async () => {
  const selected = item('keep'); seed(selected);
  const removed = await remove([selected]); interruptCompleted(removed.backupId);
  const snapshot = await backups.interrupted();
  assert.equal(snapshot.done, 1); assert.equal(snapshot.total, 1);
  await assert.rejects(backups.resolveInterrupted('finish'), /cannot prove.*identities/);
  assert.equal((await backups.resolveInterrupted('dismiss')).retained, true);
  assert.equal(f.files.has(f.pendingPath), true);
  const result = await backups.resolveInterrupted('keep');
  assert.deepEqual(result, { action: 'keep', results: [] });
  assert.equal(f.files.has(f.pendingPath), false);
  assert.equal(f.manifest(removed.backupId).complete, true);
  assert.deepEqual(mutations(), [['trash', selected.path]]);
  assert.equal((await history.list()).length, 1, 'Keep and dismiss do not invent mutation history');
});

test('interrupted rollback persists completion before clearing pending evidence', async () => {
  const selected = item('rollback'); seed(selected);
  const removed = await remove([selected]); interruptCompleted(removed.backupId);
  const result = await backups.resolveInterrupted('rollback');
  assert.equal(result.results[0].ok, true);
  assert.equal(f.present.has(selected.path), true);
  assert.equal(f.files.has(f.pendingPath), false);
  assert.equal(f.manifest(removed.backupId).recovery.status, 'completed');
  assert.equal((await history.list())[0].title, 'Rolled back an interrupted removal');
  assert.deepEqual((await backups.resolveInterrupted('rollback')).results, []);
  assert.deepEqual(mutations(), [['trash', selected.path], ['restore', selected.path]]);
});

test('partial selected restore reports exact outcomes and leaves unselected virtual files untouched', async () => {
  const first = item('restore-first'), missing = item('restore-missing'), untouched = item('restore-unselected');
  seed(first, missing, untouched);
  const removed = await remove([first, missing, untouched]);
  f.recycled.delete(missing.path);
  const result = await backups.restoreEntries({ id: removed.backupId, indexes: [0, 1] });
  assert.deepEqual(result.map(row => row.ok), [true, false]);
  assert.match(result[1].detail, /Not in the Recycle Bin/);
  assert.equal(f.present.has(first.path), true);
  assert.equal(f.recycled.has(untouched.path), true);
  assert.equal((await history.list())[0].detail, '1 of 2 entries restored');
  assert.equal(f.manifest(removed.backupId).entries.length, 3);
});

test('partial interrupted rollback retains durable progress and refuses automatic replay or new cleanup', async () => {
  const first = item('partial-first'), missing = item('partial-missing'); seed(first, missing);
  const removed = await remove([first, missing]); interruptCompleted(removed.backupId);
  f.recycled.delete(missing.path);
  const result = await backups.resolveInterrupted('rollback');
  assert.equal(result.retained, true); assert.equal(result.reviewRequired, true);
  assert.deepEqual(result.results.map(row => row.ok), [true, false]);
  assert.equal(f.files.has(f.pendingPath), true);
  assert.equal(f.manifest(removed.backupId).recovery.status, 'in-progress');
  const evidence = f.files.get(f.manifestPath(removed.backupId)), calls = mutations();
  await assert.rejects(backups.resolveInterrupted('rollback'), /partially restored.*retry is refused/);
  await assert.rejects(backups.restore(removed.backupId), /interrupted rollback requires manual review/);
  await assert.rejects(remove([missing]), /interrupted removal requires review/);
  assert.deepEqual(mutations(), calls);
  assert.equal(f.files.get(f.manifestPath(removed.backupId)), evidence);
});

test('restore cancellation stops between entries while retaining the sealed recovery package', async () => {
  const first = item('restore-cancel-first'), second = item('restore-cancel-second'); seed(first, second);
  const removed = await remove([first, second]);
  f.control.restore = async paths => {
    await backups.restoreCancel();
    f.present.add(paths[0]); f.recycled.delete(paths[0]);
    return JSON.stringify({ [paths[0]]: 'OK' });
  };
  const result = await backups.restore(removed.backupId);
  assert.equal(result[0].ok, true);
  assert.equal(result[1].ok, false); assert.match(result[1].detail, /cancelled/);
  assert.equal(f.recycled.has(second.path), true);
  assert.equal(f.manifest(removed.backupId).complete, true);
  assert.equal(f.calls.filter(([kind]) => kind === 'restore').length, 1);
});

test('prototype and unknown requests reject without invoking inherited functions or acquiring recovery admission', async () => {
  for (const channel of ['toString', '__proto__', 'constructor', 'fixture:missing']) {
    await assert.rejects(api.invoke(channel), /Unknown request/);
  }
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.approvals, []);
  assert.deepEqual(await backups.resolveInterrupted('keep'), { action: 'keep', results: [] });
});

test('rejected and thrown approvals release serialized admission before any handler effects', async () => {
  const selected = item('approval'); seed(selected);
  for (const outcome of [false, Error('approval provider failed'), 'approval non-error']) {
    f.control.approve = () => { if (outcome !== false) throw outcome; return false; };
    await assert.rejects(remove([selected]), error => outcome === false ? /Explicit approval/.test(error.message) : error === outcome);
    assert.deepEqual(f.calls, []);
  }
  delete f.control.approve;
  assert.equal((await remove([selected])).results[0].ok, true);
});

test('real invalid recovery handler and non-Error host failures release admission without retry', async () => {
  await assert.rejects(backups.resolveInterrupted('unknown'), /Invalid recovery action/);
  const selected = item('non-error'); seed(selected);
  f.control.write = path => { if (path.endsWith('pending.json')) throw 'non-Error fixture failure'; };
  await assert.rejects(remove([selected]), /non-Error fixture failure/);
  assert.equal(f.calls.filter(([kind, path]) => kind === 'write' && path.endsWith('pending.json')).length, 1);
  assert.deepEqual(mutations(), []);
  delete f.control.write;
  assert.equal((await remove([selected])).results[0].ok, true);
});
