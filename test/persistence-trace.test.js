import assert from 'node:assert/strict';
import { test } from 'node:test';
import { __handlers, mutates } from '../packages/purgeon-core/src/internal/api.js';
import { setSys } from '../src/backend/sys.js';
import { setRoot as setHistoryRoot } from '../packages/purgeon-core/src/internal/history.js';

test('startup trace dispatch passes only the closed Run identity and never exposes unexpected event fields', async () => {
  const requests = [];
  const forbidden = () => assert.fail('read-only trace attempted a mutation');
  setSys({
    persistenceTrace: async (request) => {
      requests.push(request);
      return { status: 'matches', lookbackDays: 7, events: [{ recordId: '42', atMs: 1720000000000, action: 'created', writerProcess: 'C:\\Fixture\\writer.exe', writerPid: 321, executionPid: 999, oldValue: 'secret data' }] };
    },
    writeTextAtomic: forbidden, writeText: forbidden, exec: forbidden, launch: forbidden,
  });
  const output = await __handlers['startup:trace']({ type: 'run', source: 'hklm-run32', name: 'Fixture', command: 'secret command' });
  assert.deepEqual(requests, [{ kind: 'run', source: 'hklm-run32', name: 'Fixture' }]);
  assert.equal(output.events[0].writerPid, 321);
  assert.doesNotMatch(JSON.stringify(output), /secret|executionPid|999/);
  assert.equal(mutates('startup:trace'), false);
  assert.equal(mutates('tasks:trace'), false);
});

test('only a matching machine Run disable earlier than an event can anchor the observation', async () => {
  const source = 'hklm-run32';
  const name = 'Fixture';
  const anchorAt = 1720000000000;
  const row = (time, entry = {}, record = {}) => ({
    id: String(time), type: 'Startup', title: 'Fixture', detail: '', time: new Date(time).toISOString(),
    undo: { channel: 'startup:set', arg: { enable: true, entry: { id: source + '|' + name, type: 'run', source, name, enabled: false, ...entry } } },
    ...record,
  });
  const history = [
    row(anchorAt + 1000), row(anchorAt + 900, { source: 'hklm-run' }), row(anchorAt + 800, { name: 'fixture' }),
    row(anchorAt + 700, {}, { undone: true }), row(anchorAt, {}), row(anchorAt + 500, {}, { undo: { channel: 'startup:set' } }),
  ];
  let historyReads = 0;
  const events = [1000, 0, -1000].map((offset, index) => ({ recordId: String(index + 1), atMs: anchorAt + offset, action: 'created' }));
  setSys({
    makeDir: async () => {},
    readOptionalText: async () => { historyReads++; return JSON.stringify(history); },
    persistenceTrace: async () => ({ status: 'matches', lookbackDays: 7, events }),
  });
  await setHistoryRoot('C:\\InertFixture');
  const result = await __handlers['startup:trace']({ type: 'run', source, name });
  assert.deepEqual(result.events.map((event) => event.recordedDisableAtMs), [anchorAt, undefined, undefined]);
  assert.ok(result.events.every((event) => event.action === 'created'));
  assert.equal(historyReads, 1);
  const currentUser = await __handlers['startup:trace']({ type: 'run', source: 'hkcu-run', name });
  assert.ok(currentUser.events.every((event) => !event.recordedDisableAtMs));
  assert.equal(historyReads, 1);
});

test('task trace admits only an exact full path and returns payload account, never a writer or registry data', async () => {
  const requests = [];
  const path = '\\Fixture\\Agent';
  setSys({ persistenceTrace: async (request) => {
    requests.push(request);
    const row = { recordId: '9', atMs: 1720000000000, action: 'registered', account: 'FIXTURE\\User', writerPid: 55, oldValue: 'private' };
    return { status: 'matches', lookbackDays: 7, events: [row, row, { ...row, recordId: '10', action: 'created' }] };
  } });
  assert.equal((await __handlers['tasks:trace']({ path: 'Agent' })).status, 'unsupported');
  assert.equal((await __handlers['startup:trace']({ type: 'run', source: 'unknown', name: 'Fixture' })).status, 'unsupported');
  const result = await __handlers['tasks:trace']({ path, command: 'private command' });
  assert.deepEqual(requests, [{ kind: 'task', path }]);
  assert.deepEqual(result, { status: 'partial', lookbackDays: 7, events: [{ recordId: '9', atMs: 1720000000000, action: 'registered', account: 'FIXTURE\\User' }] });
});

test('unavailable, disabled, denied, unsupported and empty results remain distinct and redacted', async () => {
  const request = { path: '\\Fixture\\Agent' };
  setSys({ persistenceTrace: undefined });
  assert.equal((await __handlers['tasks:trace'](request)).status, 'unsupported');
  setSys({ persistenceTrace: async () => { throw new Error('private provider error'); } });
  assert.deepEqual(await __handlers['tasks:trace'](request), { status: 'unavailable', lookbackDays: 7, events: [] });
  for (const status of ['disabled', 'denied', 'unsupported', 'partial', 'noMatch']) {
    setSys({ persistenceTrace: async () => ({ status, lookbackDays: 7, events: [] }) });
    assert.deepEqual(await __handlers['tasks:trace'](request), { status, lookbackDays: 7, events: [] });
  }
  setSys({ persistenceTrace: async () => ({ status: 'matches', lookbackDays: 99, events: [] }) });
  assert.equal((await __handlers['tasks:trace'](request)).status, 'unavailable');
});
