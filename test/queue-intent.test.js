import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setSys } from '../src/backend/sys.js';
import { api, __handlers } from '../src/backend/api.js';
import * as queue from '../src/backend/queue.js';

async function fixture(initial = null, launch = []) {
  let record = initial === null ? null : JSON.stringify(initial);
  const control = { failWrite: null, restartPending: false, armFail: false };
  const writes = [];
  const calls = [];
  setSys({
    info: { exe: 'C:\\QueueIntentFixture\\Purgeon.exe', env: {}, launch },
    makeDir: async () => {},
    readOptionalText: async () => record,
    writeTextAtomic: async (_path, contents) => {
      if (control.failWrite === 'before') throw Error('inert save refused');
      record = contents;
      writes.push(JSON.parse(contents));
      if (control.failWrite === 'after') throw Error('inert save response lost');
    },
    removePath: async () => { calls.push('remove'); record = null; },
    exec: async (_tool, args) => { calls.push(args); return { ok: !control.armFail, stdout: '', stderr: 'inert arm refused' }; },
    runPS: async (script) => { calls.push(script); return control.restartPending ? 'True' : 'False'; },
  });
  await queue.setRoot('C:\\QueueIntentFixture\\state');
  return { control, writes, calls, persisted: () => JSON.parse(record) };
}

test('a stale queue snapshot cannot discard entries added after it was read', async () => {
  const f = await fixture();
  await queue.add([{ key: 'a', name: 'A' }]);
  const stale = await queue.get();
  await queue.add([{ key: 'b', name: 'B' }]);
  stale.programs[0].status = 'done';
  await assert.rejects(queue.save(stale), /queue changed/);
  assert.deepEqual(f.persisted().programs.map(p => p.key), ['a', 'b']);
});

const step = (q, key = 'a', installerItems = []) => ({ key, revision: q.revision ?? 0, installerItems });
const leftover = (name) => ({ kind: 'value', path: 'HKCU\\Software\\QueueFixture', name, program: 'A' });
const finished = (leftovers = []) => ({ created: 'legacy queue', programs: [{ key: 'a', name: 'A', status: 'done' }], leftovers });

test('clearing or recreating a legacy queue does not reauthorize an old snapshot', async () => {
  const f = await fixture(finished());
  const old = await queue.get();
  await queue.clear();
  await assert.rejects(queue.save(old), /queue changed/);
  assert.equal(f.persisted(), null);
  const next = await queue.add([{ key: 'new', name: 'New' }]);
  await assert.rejects(queue.save(old), /queue changed/);
  assert.deepEqual(f.persisted(), next);
});

test('a refused or unconfirmed launch-intent write never starts the uninstaller', async () => {
  for (const failure of ['before', 'after']) {
    const f = await fixture();
    const q = await queue.add([{ key: 'a', name: 'A' }]);
    const launch = () => assert.fail('Uninstaller started without confirmed intent persistence');
    f.control.failWrite = failure;
    await assert.rejects(queue.runStep(step(q), launch), /inert save/);
    f.control.failWrite = null;
    if (failure === 'before') {
      assert.deepEqual(f.persisted(), q);
    } else {
      const interrupted = f.persisted();
      assert.equal(interrupted.programs[0].status, 'launching');
      await assert.rejects(queue.runStep(step(interrupted), launch), /interrupted or unfinished/);
    }
  }
});

test('only one intent may launch and a live attempt cannot be acknowledged as interrupted', async () => {
  const f = await fixture();
  const q = await queue.add([{ key: 'a', name: 'A' }, { key: 'b', name: 'B' }]);
  const installerItems = [{ kind: 'file', path: 'C:\\Fixture\\installed.exe' }];
  let release, launched;
  const launchSeen = new Promise(resolve => { launched = resolve; });
  const run = queue.runStep(step(q, 'a', installerItems), async p => {
    assert.equal(p.key, 'a');
    assert.equal(f.persisted().programs[0].status, 'launching');
    assert.deepEqual(f.persisted().intent.installerItems, installerItems);
    return new Promise(resolve => { release = resolve; launched(); });
  });
  await launchSeen;
  try {
    const pending = await queue.get();
    await assert.rejects(queue.runStep(step(pending, 'b'), () => assert.fail('Duplicate launch')), /interrupted or unfinished/);
    await assert.rejects(queue.reviewInterrupted(pending.intent.token), /still running/);
    for (const action of [() => queue.add([{ key: 'c' }]), () => queue.remove('b'), () => queue.save(pending), () => queue.clear()]) {
      await assert.rejects(action, /interrupted or unfinished/);
    }
  } finally {
    release({ ok: true, code: 3010 });
  }
  const known = await run;
  assert.equal(known.restartNeeded, true);
  assert.equal(known.programs[0].status, 'cleanupPending');
  assert.equal(f.calls.length, 0, 'restart code never ran a reboot or changed RunOnce');
  const complete = await queue.scanStep(known.intent.token, async p => {
    assert.deepEqual(p.installerItems, installerItems);
    return [leftover('saved')];
  });
  assert.equal(complete.intent, undefined);
  assert.deepEqual(complete.programs.map(p => p.status), ['done', 'pending']);
  assert.equal(complete.leftovers[0].name, 'saved');
  await assert.rejects(queue.scanStep(known.intent.token, () => assert.fail('Stale scan repeated')), /queue changed/);
});

test('unknown launch outcomes require explicit review and never replay the uninstaller', async () => {
  for (const launch of [
    async () => { throw Error('inert uninstaller response lost'); },
    async () => ({ ok: false, code: -1 }),
    async () => undefined,
  ]) {
    const f = await fixture();
    const q = await queue.add([{ key: 'a', name: 'A' }]);
    await assert.rejects(queue.runStep(step(q), launch));
    const intent = f.persisted().intent;
    await queue.setRoot('C:\\QueueIntentFixture\\state');
    await assert.rejects(queue.scanStep(intent.token, () => assert.fail('Scan without acknowledgement')), /queue changed/);
    const reviewed = await queue.reviewInterrupted(intent.token);
    assert.equal(reviewed.intent.outcome.status, 'skipped');
    const done = await queue.scanStep(intent.token, async () => []);
    assert.equal(done.programs[0].status, 'skipped');
    assert.equal(done.intent, undefined);
  }
});

test('an unconfirmed outcome write recovers conservatively and retries a failed scan only', async () => {
  for (const failure of ['before', 'after']) {
    const f = await fixture();
    const q = await queue.add([{ key: 'a', name: 'A' }]);
    let launches = 0;
    await assert.rejects(queue.runStep(step(q), async () => {
      launches++;
      f.control.failWrite = failure;
      return { ok: false, code: 1641 };
    }), /inert save/);
    f.control.failWrite = null;
    let persisted = await queue.get();
    assert.equal(persisted.programs[0].status, failure === 'before' ? 'launching' : 'cleanupPending');
    assert.equal(!!persisted.restartNeeded, failure === 'after');
    if (failure === 'before') persisted = await queue.reviewInterrupted(persisted.intent.token);
    await assert.rejects(queue.scanStep(persisted.intent.token, async () => { throw Error('inert scan failure'); }), /inert scan failure/);
    await assert.rejects(queue.scanStep(persisted.intent.token, async () => null), /scan did not complete/);
    assert.deepEqual(f.persisted(), persisted);
    f.control.failWrite = 'after';
    await assert.rejects(queue.scanStep(persisted.intent.token, async () => [leftover('once')]), /response lost/);
    f.control.failWrite = null;
    assert.equal(launches, 1);
    assert.equal(f.persisted().leftovers.length, 1);
    assert.equal(f.persisted().programs[0].status, failure === 'before' ? 'skipped' : 'done');
    await assert.rejects(queue.scanStep(persisted.intent.token, () => assert.fail('Completed scan repeated')), /queue changed/);
  }
});

test('desktop queue admission uses wrapped handlers, preserves result failure and checks Windows restart', async (t) => {
  const f = await fixture();
  const q = await queue.add([{ key: 'a', name: 'A' }]);
  f.control.restartPending = true;
  const priorLaunch = __handlers['program:runUninstaller'];
  const priorScan = __handlers['program:scan'];
  t.after(() => {
    __handlers['program:runUninstaller'] = priorLaunch;
    __handlers['program:scan'] = priorScan;
  });
  __handlers['program:runUninstaller'] = async p => {
    assert.equal(p.key, 'a');
    assert.equal(f.persisted().intent.key, p.key);
    return { ok: false, code: 5, error: 'fixture uninstaller failed' };
  };
  __handlers['program:scan'] = async p => {
    assert.equal(p.key, 'a');
    assert.equal(f.persisted().intent.outcome.status, 'failed');
    return [];
  };
  const persisted = await api.invoke('queue:runStep', step(q));
  assert.equal(persisted.restartNeeded, true);
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0], /RebootPending/);
  const complete = await api.invoke('queue:scanStep', persisted.intent.token);
  assert.equal(complete.programs[0].status, 'failed');
  assert.equal(complete.programs[0].detail, 'fixture uninstaller failed');
  await assert.rejects(api.invoke('queue:reviewInterrupted', persisted.intent.token), /queue changed/);
});

test('leftover cleanup retires only selected, exact, confirmed successes', async (t) => {
  const first = leftover('first'), failed = leftover('failed'), uncertain = leftover('uncertain'), unselected = leftover('unselected');
  const f = await fixture(finished([first, failed, uncertain, unselected]));
  const original = __handlers['items:remove'];
  t.after(() => { __handlers['items:remove'] = original; });
  const result = { cancelled: true, backupId: 'fixture', results: [
    { ...first, ok: true }, { ...failed, ok: false }, { ...uncertain, ok: true, uncertain: true },
    { ...unselected, ok: true },
  ] };
  __handlers['items:remove'] = async ({ title, items, owners }) => {
    assert.equal(title, 'Uninstall queue');
    assert.deepEqual(items, [first, failed, uncertain]);
    assert.deepEqual(owners, ['a']);
    return result;
  };
  assert.equal(await api.invoke('queue:removeLeftovers', { revision: 0, items: [first, failed, uncertain] }), result);
  assert.deepEqual(f.persisted().leftovers, [failed, uncertain, unselected]);
  const q = await queue.get();
  await assert.rejects(queue.removeLeftovers({ revision: q.revision, items: [first] }, () => assert.fail('Missing item removed')), /queue changed/);
  const interrupted = { interrupted: true, recoveryRequired: true, results: [{ ...failed, ok: true }] };
  assert.equal(await queue.removeLeftovers({ revision: q.revision, items: [failed] }, async () => interrupted), interrupted);
  assert.deepEqual(f.persisted(), q);
});

test('unconfirmed leftover retirement preserves the removal receipt and concurrent queue data', async () => {
  const item = leftover('same-name');
  for (const change of ['clear-recreate', 'write-refused']) {
    const f = await fixture(finished(change === 'write-refused' ? [item, leftover('retained')] : [item]));
    let release, entered;
    const effectSeen = new Promise(resolve => { entered = resolve; });
    const result = { backupId: 'fixture', results: [{ ...item, ok: true }] };
    const remove = queue.removeLeftovers({ revision: 0, items: [item] }, async () => {
      return new Promise(resolve => { release = resolve; entered(); });
    });
    await effectSeen;
    let expected;
    if (change === 'clear-recreate') {
      await queue.clear();
      const fresh = await queue.add([{ key: 'different', name: 'New' }]);
      expected = await queue.save({ ...fresh, leftovers: [item] });
    } else {
      f.control.failWrite = 'before';
      expected = f.persisted();
    }
    release(result);
    assert.deepEqual(await remove, { ...result, queueRetirementUnconfirmed: true });
    assert.deepEqual(f.persisted(), expected);
  }
});

test('a restart obligation survives scan completion and failed RunOnce arming', async () => {
  const f = await fixture();
  const q = await queue.add([{ key: 'a', name: 'A' }, { key: 'b', name: 'B' }]);
  const launched = await queue.runStep(step(q), async () => ({ ok: true, code: 3010 }));
  const token = launched.restartToken;
  const scanned = await queue.scanStep(launched.intent.token, async () => []);
  assert.equal(scanned.intent, undefined);
  assert.equal(scanned.restartToken, token);
  await assert.rejects(queue.runStep(step(scanned, 'b'), () => assert.fail('Launched before restart')), /waiting for Windows/);
  for (const action of [() => queue.clear(), () => queue.add([{ key: 'c' }]), () => queue.remove('b'), () => queue.save(scanned), () => queue.removeLeftovers({ revision: scanned.revision, items: [] }, () => assert.fail('Removed before restart'))]) {
    await assert.rejects(action, /waiting for Windows/);
  }
  await assert.rejects(queue.acknowledgeRestart(token), /sign-in resume/);
  await assert.rejects(queue.armRestart(null), /queue changed/);
  f.control.armFail = true;
  await assert.rejects(api.invoke('queue:armRestart', token), /inert arm refused/);
  assert.deepEqual(f.persisted(), scanned);
  f.control.armFail = false;
  await api.invoke('queue:armRestart', token);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.persisted(), scanned);

  const restarted = await fixture(f.persisted(), ['--resume-queue']);
  await assert.rejects(api.invoke('queue:acknowledgeRestart', null), /queue changed/);
  const ready = await api.invoke('queue:acknowledgeRestart', token);
  assert.equal(ready.restartNeeded, false);
  assert.equal(ready.restartToken, undefined);
  await assert.rejects(queue.acknowledgeRestart(null), /sign-in resume/);
  const next = await queue.runStep(step(ready, 'b'), async () => ({ ok: true, code: 0 }));
  assert.equal(next.intent.key, 'b');
  assert.equal(restarted.persisted().programs[0].status, 'done');
});

test('sign-in resume clears only the exact saved restart, including legacy and scan-pending queues', async () => {
  const old = await fixture({ ...finished(), restartNeeded: true }, ['--RESUME-QUEUE']);
  const legacy = await queue.acknowledgeRestart(null);
  assert.equal(legacy.restartNeeded, false);
  assert.deepEqual(old.persisted(), legacy);
  const f = await fixture();
  const q = await queue.add([{ key: 'a', name: 'A' }]);
  const launched = await queue.runStep(step(q), async () => ({ ok: true, code: 1641 }));
  await fixture(f.persisted(), ['--resume-queue']);
  const ready = await queue.acknowledgeRestart(launched.restartToken);
  assert.equal(ready.intent.outcome.restartNeeded, false);
  const complete = await queue.scanStep(ready.intent.token, async () => []);
  assert.equal(complete.programs[0].status, 'done');
  assert.equal(complete.restartNeeded, false);
  await fixture(null, ['--resume-queue']);
  assert.equal(await queue.acknowledgeRestart(null), null);
  await assert.rejects(queue.acknowledgeRestart(null), /sign-in resume/);
});

test('confirmed removal of every leftover retires the completed queue and permits requeue', async () => {
  const item = leftover('all');
  const f = await fixture(finished([item]));
  const result = { backupId: 'fixture', results: [{ ...item, ok: true }] };
  assert.equal(await queue.removeLeftovers({ revision: 0, items: [item] }, async () => result), result);
  assert.equal(f.persisted(), null);
  const pending = await queue.add([{ key: 'a', name: 'Reinstalled A' }]);
  assert.equal(pending.programs[0].status, 'pending');
});
