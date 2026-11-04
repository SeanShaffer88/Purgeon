import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setSys, sys } from '../src/backend/sys.js';
import * as monitor from '../src/backend/monitor.js';
import { api } from '../src/backend/api.js';
import { runCli } from '../src/cli.js';

test('actual MonitorWizard handlers preserve cancel states and successful retries', async () => {
  const source = fs.readFileSync(new URL('../src/dialogs.jsx', import.meta.url), 'utf8');
  const start = source.indexOf('  const begin = async () => {', source.indexOf('export function MonitorWizard'));
  const body = source.slice(start, source.indexOf('  const cancel = async () => {', start));
  assert.ok(start >= 0 && body.includes('const finish = async'));
  const calls = [], record = { items: [], name: 'Fixture' };
  let cancelled = true;
  const handlers = new Function('api', 'setError', 'setStep', 'setLive', 'installer', 'name', 'onRecorded', `${body}; return { begin, finish };`)(
    { invoke: async (channel) => { calls.push(channel); return cancelled ? { cancelled: true } : channel === 'monitor:finish' ? record : { live: true }; } },
    () => {}, step => calls.push(step), live => calls.push(['live', live]), 'C:\\fixture.exe', ' Fixture ', value => calls.push(value));
  await handlers.begin();
  assert.deepEqual(calls, ['before', 'monitor:start', 'pick']);
  calls.length = 0;
  await handlers.finish();
  assert.deepEqual(calls, ['after', 'monitor:finish', 'installing']);
  cancelled = false;
  calls.length = 0;
  await handlers.begin();
  assert.deepEqual(calls, ['before', 'monitor:start', ['live', true], 'monitor:launch', 'installing']);
  calls.length = 0;
  await handlers.finish();
  assert.deepEqual(calls, ['after', 'monitor:finish', record]);
});

const root = 'C:\\AuditMonitor', session = `${root}\\session.json`, before = `${root}\\session-before.snap`;
const resultFile = 'C:\\FixtureApp\\test-install-last.json';
async function fixture() {
  const files = new Map([[session, JSON.stringify({ started: '2026-01-01', installer: '', live: true })],
    [before, 'BEFORE'], [resultFile, 'PREVIOUS RESULT']]);
  const calls = [], control = { cancel: true, live: true }, output = [];
  setSys({ info: { env: {}, home: 'C:\\FixtureHome', dataDir: 'C:\\FixtureApp' }, makeDir: async () => {},
    readText: async (p) => { calls.push(['read', p]); if (!files.has(p)) throw Error('missing'); return files.get(p); },
    readOptionalText: async (p) => files.get(p) ?? null, exists: async (p) => files.has(p),
    takeSnapshot: async (p) => { calls.push(['capture', p]); if (control.cancel) throw Error('cancelled'); return { dirs: 1, files: 2, keys: 3, values: 4 }; },
    trackStart: async () => { calls.push(['trackStart']); return true; },
    trackRunning: async () => control.live,
    trackStop: async () => { calls.push(['trackStop']); control.live = false; return null; },
    compareSnapshots: async () => { calls.push(['compare']); return { added: [], changed: [], removed: [] }; },
    writeTextAtomic: async (p, text) => { calls.push(['write', p]); if (control.fail === p) throw Error('save denied'); files.set(p, text); },
    removePath: async (p) => { calls.push(['remove', p]); files.delete(p); },
    runPS: async () => { calls.push(['runPS']); return ''; },
    print: async (s) => output.push(s), quit: async (code) => { control.exit = code; },
  });
  await monitor.setRoot(root);
  return { files, calls, control, output };
}

for (const name of ['start', 'attach', 'testInstallStart', 'finish', 'testInstallFinish']) {
  test(`${name} cancellation preserves evidence and stops before tracking, writes, comparison and cleanup; retry succeeds`, async () => {
    const f = await fixture();
    const original = [...f.files];
    const arg = ['start', 'attach', 'testInstallStart'].includes(name) ? 'C:\\FixtureSetup.exe' : '';
    assert.deepEqual(await monitor[name](arg), { cancelled: true });
    assert.deepEqual([...f.files], original);
    assert.ok(f.calls.every(([action]) => action === 'capture' || action === 'read'));
    assert.equal(f.control.live, true);
    f.control.cancel = false;
    const result = await monitor[name](arg);
    assert.equal(result.cancelled, undefined);
    if (['start', 'attach', 'testInstallStart'].includes(name)) assert.equal(result.entries, 10);
    else {
      assert.deepEqual(result.items, []);
      const save = f.calls.findIndex(([action, p]) => action === 'write' && (p === resultFile || p.includes('programs\\')));
      const cleanup = f.calls.findIndex(([action]) => action === 'remove');
      assert.ok(save >= 0 && cleanup > save);
      assert.equal(f.calls.filter(([action]) => action === 'trackStop').length, 1);
    }
  });
}

test('failed finish persistence retains session evidence for both normal and disposable monitoring', async () => {
  for (const name of ['finish', 'testInstallFinish']) {
    const f = await fixture();
    f.control.cancel = false;
    const write = sys.writeTextAtomic;
    sys.writeTextAtomic = async (p, text) => { if (p === resultFile || p.includes('programs\\')) throw Error('save denied'); return write(p, text); };
    await assert.rejects(monitor[name](''), /save denied/);
    assert.equal(f.files.get(before), 'BEFORE');
    assert.equal(f.files.get(resultFile), 'PREVIOUS RESULT');
    assert.ok(f.files.has(session));
    assert.ok(!f.calls.some(([action]) => action === 'remove'));
  }
});

test('API cancelled finish returns without success history or portable classification', async () => {
  for (const channel of ['monitor:finish', 'monitor:test-install-finish']) {
    const f = await fixture();
    assert.deepEqual(await api.invoke(channel, ''), { cancelled: true });
    assert.ok(!f.calls.some(([action]) => ['write', 'remove', 'compare', 'trackStop'].includes(action)));
  }
});

test('API successful disposable finish retains its record and assessment result shape', async () => {
  const f = await fixture();
  f.control.cancel = false;
  f.control.live = false;
  sys.compareSnapshots = async () => ({ added: [{ kind: 'file', path: 'C:\\Apps\\fixture-driver.sys' }], removed: [], changed: [] });
  const result = await api.invoke('monitor:test-install-finish', 'Fixture');
  assert.equal(result.name, 'Fixture');
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].path, 'C:\\Apps\\fixture-driver.sys');
  assert.equal(result.portable, false);
  assert.ok(result.reasons.some(reason => reason.includes('fixture-driver.sys')));
});

for (const boundary of ['normal start', 'normal finish', 'test start', 'test finish']) {
  test(`CLI ${boundary} cancellation does not launch after cancellation or print missing fields`, async () => {
    const f = await fixture();
    const installer = 'C:\\FixtureSetup.exe';
    let captures = 0, launches = 0;
    f.control.live = false;
    f.files.set(installer, 'inert fixture');
    if (boundary.endsWith('start') || boundary === 'normal finish') f.files.delete(session);
    sys.takeSnapshot = async () => {
      if (++captures === (boundary === 'normal finish' ? 2 : 1)) throw Error('cancelled');
      return { dirs: 1, files: 1, keys: 1, values: 1 };
    };
    sys.trackStart = undefined;
    sys.runCommandLine = async () => { launches++; return { ok: true }; };
    const args = boundary.startsWith('test') ? ['--monitor', boundary === 'test start' ? 'test-install-start' : 'test-install-finish',
      ...(boundary === 'test start' ? ['--installer', installer] : [])] : ['--monitor', installer];
    await runCli(boundary.startsWith('test') ? [...args, '--json'] : args, async () => {});
    if (boundary.startsWith('test')) assert.equal(JSON.parse(f.output.join('').trim()).ok, false);
    assert.match(f.output.join(''), /cancelled/i);
    assert.doesNotMatch(f.output.join(''), /undefined|NaN|Portable:/);
    assert.equal(launches, boundary === 'normal finish' ? 1 : 0);
    assert.ok(!f.calls.some(([action]) => ['compare', 'remove'].includes(action)));
  });
}

test('CLI successful disposable finish uses the existing portable classifier', async () => {
  const f = await fixture();
  f.control.cancel = false;
  f.control.live = false;
  sys.compareSnapshots = async () => ({ added: [{ kind: 'file', path: 'C:\\Apps\\driver.sys' }], removed: [], changed: [] });
  await runCli(['--monitor', 'test-install-finish', '--json'], async () => {});
  const envelope = JSON.parse(f.output.join('').trim());
  assert.equal(envelope.ok, true);
  assert.match(envelope.output, /Portable: NO/);
  assert.match(envelope.output, /driver/);
  assert.equal(f.control.exit, 0);
});

test('cancelled detected installer attach never opens the resumed wizard', async () => {
  const source = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('  const monitorDetected = async (inst) => {'), source.indexOf('  // Keyboard shortcuts (', source.indexOf('  const monitorDetected = async (inst) => {')));
  const calls = [];
  const run = new Function('api', 'setModal', 'setBusy', 'setError', 'tx', `${body}; return monitorDetected;`)(
    { invoke: async (channel) => { calls.push(channel); return { cancelled: true }; } },
    (value) => calls.push(value), () => {}, () => {}, (value) => value);
  await run({ name: 'Fixture', path: 'C:\\fixture.exe' });
  assert.deepEqual(calls, [null, 'monitor:attach']);
});
