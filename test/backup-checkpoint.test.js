import test from 'node:test';
import assert from 'node:assert/strict';
import { setSys } from '../src/backend/sys.js';
import * as backups from '../src/backend/backups.js';
import * as history from '../src/backend/history.js';

let sequence = 0;
const noState = { programs: [], shared: [] };
const item = (name, kind = 'file') => ({ kind, path: `C:\\CheckpointTemp\\${name}` });
async function fixture({ failAt, persistent = false, committed = false, pendingFailure = false, pendingReadDenied = false, firewall = 'GONE' } = {}) {
  const root = `C:\\CheckpointFixture${++sequence}`, files = new Map(), calls = [];
  let manifestWrites = 0;
  setSys({
    info: { dataDir: root, env: { TEMP: 'C:\\CheckpointTemp' } },
    makeDir: async (path) => { calls.push(['mkdir', path]); }, stat: async (path) => { calls.push(['stat', path]); return null; },
    readOptionalText: async (path) => { if (pendingReadDenied && path.endsWith('pending.json')) throw Error('Pending read denied'); return files.get(path) ?? null; },
    readText: async (path) => { calls.push(['read', path]); if (!files.has(path)) throw Error('Missing fixture file'); return files.get(path); },
    secretGet: async () => '', secretKeys: async () => [],
    writeTextAtomic: async (path, text) => {
      calls.push(['write', path, text]);
      if (path.endsWith('pending.json') && pendingFailure) throw Error('Pending save denied');
      if (path.endsWith('manifest.json')) {
        manifestWrites++;
        if (manifestWrites === failAt || persistent && manifestWrites >= failAt) {
          if (committed) files.set(path, text);
          throw Error('Checkpoint save denied');
        }
      }
      files.set(path, text);
    },
    writeText: async (path, text) => { calls.push(['write', path, text]); files.set(path, text); },
    removePath: async (path) => { calls.push(['remove', path]); files.delete(path); },
    exists: async () => true, readDir: async () => [], sha256Files: async () => [],
    runPS: async (script) => { calls.push(['ps', script]); return firewall; },
    exec: async (path, args) => { calls.push(['exec', path, args]); return { ok: true, stdout: '', stderr: '' }; },
    prepareTask: async () => { calls.push(['prepareTask']); return { id: 'b'.repeat(32), summary: 'Fixture', requiresElevation: false }; },
    executeTask: async () => { calls.push(['executeTask']); return { ok: true, journalId: 'b'.repeat(32), changed: true, settled: true, recoverable: true }; },
  });
  await history.setRoot(`${root}\\history`);
  await backups.setRoot(`${root}\\backups`);
  return {
    calls, files,
    run: (items, options = {}) => backups.removeItems({ title: 'checkpoint fixture', items, state: noState, trashItem: async (path) => { calls.push(['trash', path]); }, ...options }),
    manifest: () => JSON.parse([...files].find(([path]) => path.endsWith('manifest.json'))[1]),
    manifestWrites: () => manifestWrites,
  };
}
const assertRetained = (f) => {
  assert.ok([...f.files.keys()].some((path) => path.endsWith('pending.json')), 'pending recovery marker is retained');
  assert.equal(f.calls.some(([kind]) => kind === 'remove'), false, 'no recovery data is deleted');
};

test('failed file completion checkpoint stops before the next item and retains unresolved recovery evidence', async () => {
  const f = await fixture({ failAt: 3 });
  const result = await f.run([item('first'), item('second'), item('later-junk', 'junk')]);
  assert.deepEqual(f.calls.filter(([kind]) => kind === 'trash').map(([, path]) => path), [item('first').path]);
  assert.equal(result.interrupted, true);
  assert.equal(result.recoveryRequired, true);
  assert.equal(result.results[0].ok, false);
  assert.match(result.results[0].detail, /recovery|checkpoint/i);
  assert.match(result.results[1].detail, /Left in place/);
  assert.equal(f.manifestWrites(), 3, 'failed checkpoint is not retried or sealed');
  const stored = f.manifest();
  assert.equal(stored.complete, false);
  assert.equal(stored.entries.length, 0);
  assert.equal(stored.inFlight.path, item('first').path);
  assert.equal(stored.intents[0].status, undefined);
  assertRetained(f);
});

test('completion checkpoint failure blocks empty and nonempty cleanups without changing evidence or performing side effects', async () => {
  const f = await fixture({ failAt: 3 });
  assert.equal((await f.run([item('first')])).recoveryRequired, true);
  const files = [...f.files], calls = [...f.calls];
  for (const items of [[], [item('second')]]) {
    await assert.rejects(f.run(items), /Recovery needs review.*interrupted removal/i);
    assert.deepEqual([...f.files], files, 'all retained evidence stays byte-identical');
    assert.deepEqual(f.calls, calls, 'no settings reads, writes, directories, deletions, or mutations');
  }
});

test('corrupt, unreadable, and valid pending records with missing manifests block new cleanups', async () => {
  for (const state of ['badJSON', 'readDenied', 'missingManifest']) {
    const f = await fixture({ pendingReadDenied: state === 'readDenied' });
    const pending = `C:\\CheckpointFixture${sequence}\\backups\\pending.json`;
    f.files.set(pending, state === 'badJSON' ? '{broken' : JSON.stringify({ id: 'missing', title: 'Interrupted', started: new Date().toISOString(), items: [] }));
    const files = [...f.files], calls = [...f.calls];
    for (const items of [[], [item('second')]]) {
      await assert.rejects(f.run(items), state === 'readDenied' ? /Recovery needs review.*Pending read denied/ : /Recovery needs review/);
      assert.deepEqual([...f.files], files);
      assert.deepEqual(f.calls, calls);
    }
  }
});

test('new cleanup succeeds after explicit recovery resolution', async () => {
  const f = await fixture({ failAt: 4 });
  await assert.rejects(f.run([item('first')]), /Checkpoint save denied/);
  await assert.rejects(f.run([item('second')]), /Recovery needs review/);
  await backups.resolveInterrupted('keep');
  assert.equal(await backups.interrupted(), null);
  assert.equal((await f.run([item('second')])).results[0].ok, true);
  assert.equal(await backups.interrupted(), null);
});

test('failed junk completion checkpoint halts later junk even when every subsequent write would fail', async () => {
  const f = await fixture({ failAt: 3, persistent: true });
  const result = await f.run([item('first', 'junk'), item('second', 'junk')]);
  assert.equal(f.calls.filter(([kind]) => kind === 'trash').length, 1);
  assert.equal(result.interrupted, true);
  assert.equal(result.recoveryRequired, true);
  assert.equal(f.manifestWrites(), 3);
  assertRetained(f);
});

test('failed intent checkpoint prevents mutation and keeps its unresolved recovery state', async () => {
  for (const kind of ['file', 'junk']) {
    const f = await fixture({ failAt: 2 });
    if (kind === 'junk') await assert.rejects(f.run([item('first', kind), item('second', kind)]), /Recovery checkpoint/);
    else assert.equal((await f.run([item('first'), item('second')])).interrupted, true);
    assert.equal(f.calls.some(([call]) => call === 'trash'), false);
    assert.equal(f.manifestWrites(), 2);
    assertRetained(f);
  }
});

test('commit then rejection is still a permanent halt with no retry or recovery deletion', async () => {
  const f = await fixture({ failAt: 3, committed: true });
  const result = await f.run([item('first'), item('second')]);
  assert.equal(f.calls.filter(([kind]) => kind === 'trash').length, 1);
  assert.equal(result.interrupted, true);
  assert.equal(result.recoveryRequired, true);
  assert.equal(f.manifestWrites(), 3);
  assert.equal(f.manifest().complete, false);
  assert.equal(f.manifest().entries.length, 1, 'committed completion is retained without pretending the write was confirmed');
  assertRetained(f);
});

test('failed unchanged firewall checkpoint rejects before any later cleanup or finalization', async () => {
  const f = await fixture({ failAt: 3 });
  await assert.rejects(f.run([{ kind: 'firewall', path: 'FixtureRule' }, { kind: 'firewall', path: 'LaterRule' }, item('later')]), /Recovery checkpoint/);
  assert.equal(f.calls.filter(([kind]) => kind === 'ps').length, 1);
  assert.equal(f.calls.some(([kind]) => kind === 'trash'), false);
  assert.equal(f.manifest().inFlight.path, 'FixtureRule');
  assert.equal(f.manifest().intents[0].status, undefined);
  assertRetained(f);
});

test('uncaught registry completion checkpoint failure retains the intent and rejects before the next deletion', async () => {
  const f = await fixture({ failAt: 3 });
  await assert.rejects(f.run([{ kind: 'key', path: 'HKCU\\Software\\CheckpointFixture' }, { kind: 'key', path: 'HKCU\\Software\\LaterFixture' }, item('later')]), /Recovery checkpoint/);
  assert.equal(f.calls.filter(([kind, , args]) => kind === 'exec' && args[0] === 'delete').length, 1);
  assert.equal(f.manifest().inFlight.path, 'HKCU\\Software\\CheckpointFixture');
  assertRetained(f);
});

test('task completion checkpoint failure retains native journal and never retries or prepares later tasks', async () => {
  const f = await fixture({ failAt: 3 });
  const task = { kind: 'task', path: '\\Vendor\\Fixture', name: 'Fixture', taskId: 'a'.repeat(32) };
  const result = await f.run([task, { ...task, path: '\\Vendor\\Later' }, item('later')]);
  assert.equal(result.interrupted, true);
  assert.equal(f.calls.filter(([kind]) => kind === 'executeTask').length, 1);
  assert.equal(f.calls.filter(([kind]) => kind === 'prepareTask').length, 1);
  assert.equal(f.manifestWrites(), 3);
  assert.equal(f.manifest().inFlight.nativeTaskJournalId, 'b'.repeat(32));
  assertRetained(f);
});

test('initial and pending checkpoint failures reject before the first mutation', async () => {
  for (const options of [{ failAt: 1 }, { pendingFailure: true }]) {
    const f = await fixture(options);
    await assert.rejects(f.run([item('first')]), /save denied|Recovery checkpoint/);
    assert.equal(f.calls.some(([kind]) => kind === 'trash' || kind === 'remove'), false);
  }
});

test('final seal failure rejects and preserves completed entries plus pending marker', async () => {
  const f = await fixture({ failAt: 4 });
  await assert.rejects(f.run([item('first')]), /Checkpoint save denied/);
  assert.equal(f.calls.filter(([kind]) => kind === 'trash').length, 1);
  assert.equal(f.manifest().complete, false);
  assert.equal(f.manifest().entries.length, 1);
  assertRetained(f);
});

test('normal success seals a backup and cancellation still seals only confirmed removals', async () => {
  for (const cancel of [false, true]) {
    const f = await fixture();
    let stopped = false;
    const result = await f.run([item('first'), item('second')], {
      shouldStop: () => stopped,
      trashItem: async (path) => { f.calls.push(['trash', path]); stopped = cancel; },
    });
    assert.equal(result.cancelled, cancel);
    assert.equal(result.interrupted, undefined);
    assert.equal(f.manifest().complete, true);
    assert.equal(f.manifest().entries.length, cancel ? 1 : 2);
    assert.equal([...f.files.keys()].some((path) => path.endsWith('pending.json')), false);
  }
});
