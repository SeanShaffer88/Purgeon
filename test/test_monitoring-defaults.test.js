import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parse } from 'espree';
import { DEFAULT_SETTINGS, readSettings } from '../src/backend/settings.js';
import { setSys } from '../src/backend/sys.js';
import * as insights from '../src/backend/insights.js';

const source = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true }, range: true });
const nodes = [];
function visit(node) {
  if (!node || typeof node !== 'object') return;
  if (node.type) nodes.push(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') visit(value);
  }
}
visit(ast);
const effect = (names) => nodes.find((n) => n.type === 'CallExpression' && n.callee.name === 'useEffect' && JSON.stringify(n.arguments[1]?.elements?.map((x) => x.name)) === JSON.stringify(names)).arguments[0];
const callback = (name) => nodes.find((n) => n.type === 'VariableDeclarator' && n.id.name === name).init;
const compile = (node, deps) => Function(...Object.keys(deps), `return (${source.slice(...node.range)});`)(...Object.values(deps));
function clock() {
  let id = 0;
  const pending = new Map();
  const add = (fn) => { pending.set(++id, fn); return id; };
  const remove = (key) => pending.delete(key);
  return { pending, setTimeout: add, setInterval: add, clearTimeout: remove, clearInterval: remove };
}

test('missing monitoring preferences default off without external operations', async () => {
  let calls = 0;
  setSys({ stat: async () => null, info: { dataDir: 'C:\\MonitoringFixture' }, runPS: async () => { calls++; throw Error('Forbidden'); } });
  const settings = await readSettings();
  for (const key of ['detectInstallers', 'startupMonitoring', 'resourceAlerts', 'recordSizeHistory']) {
    assert.equal(DEFAULT_SETTINGS[key], false);
    assert.equal(settings[key], false);
  }
  assert.equal(calls, 0);
});

test('saved monitoring opt-ins remain explicit true', async () => {
  const saved = Object.fromEntries(['detectInstallers', 'startupMonitoring', 'resourceAlerts', 'recordSizeHistory'].map((key) => [key, true]));
  setSys({ info: { dataDir: 'C:\\SavedMonitoringFixture' }, stat: async () => ({ modified: 12345 }), readText: async () => JSON.stringify(saved) });
  const settings = await readSettings();
  for (const key of Object.keys(saved)) assert.equal(settings[key], true);
});

test('actual insights preserve existing growth while history writes require opt-in, including a late disable', async () => {
  const files = new Map(), writes = [];
  let revision = 50000, enabled = false, blockHistory = false, release;
  const root = 'C:\\InsightsMonitoringFixture';
  const settingsFile = root + '\\settings.json', historyFile = root + '\\insights\\sizes.json';
  const day = new Date().toISOString().slice(0, 10);
  const previousDay = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  files.set(historyFile, JSON.stringify({ a: [[previousDay, 100], [day, 100000]] }));
  const sys = {
    info: { dataDir: root }, makeDir: async () => {}, stat: async (file) => file === settingsFile ? { modified: revision } : null,
    readDir: async () => [],
    readText: async (file) => {
      if (file === settingsFile) return JSON.stringify({ recordSizeHistory: enabled });
      if (file === historyFile && blockHistory) { blockHistory = false; await new Promise((resolve) => { release = resolve; }); }
      if (!files.has(file)) throw Error('Missing fixture');
      return files.get(file);
    },
    writeTextAtomic: async (file, value) => { writes.push(file); files.set(file, value); },
  };
  setSys(sys);
  await insights.setRoot(root + '\\insights');
  const list = [{ key: 'a', name: 'Fixture', publisher: '', sizeKB: 100001 }];
  const result = await insights.programInsights(list);
  assert.ok(result.a.growth, 'previous growth remains visible without recording');
  assert.deepEqual(writes, []);
  enabled = true; revision++;
  await insights.programInsights(list);
  assert.deepEqual(writes, [historyFile]);
  writes.length = 0;
  blockHistory = true;
  const pending = insights.recordSizes(list);
  while (!release) await new Promise(setImmediate);
  enabled = false; revision++;
  release();
  await pending;
  assert.deepEqual(writes, [], 'pre-commit preference check rejects a late disable');
});

for (const [flag, channel, name] of [['startupMonitoring', 'startup:newEntries', 'checkStartup'], ['resourceAlerts', 'processes:sample', 'checkAlerts']]) {
  test(`${flag}: readiness/defaults schedule nothing; opt-in starts timers; disabling rejects late output`, async () => {
    const time = clock();
    let resolve;
    const requests = [], output = [];
    const check = compile(callback(name), { api: { invoke: (key) => { requests.push(key); return new Promise((r) => { resolve = r; }); } }, notify: (...args) => output.push(args), setModal: (v) => output.push(v), setNotice: (v) => output.push(v), setError: (v) => output.push(v), tx: (v) => v });
    const start = (ready, enabled) => compile(effect(['settingsReady', flag]), { ...time, settingsReady: ready, [flag]: enabled, [name]: check })();
    assert.equal(start(false, true), undefined);
    assert.equal(start(true, false), undefined);
    assert.equal(time.pending.size, 0);
    const stop = start(true, true);
    assert.equal(time.pending.size, 2, 'one initial check and one recurring timer');
    const running = [...time.pending.values()][0]();
    assert.deepEqual(requests, [channel]);
    stop();
    assert.equal(time.pending.size, 0);
    resolve(flag === 'resourceAlerts' ? { alerts: ['hot'] } : [{ name: 'entry' }]);
    await running;
    assert.deepEqual(output, []);
    const stopAgain = start(true, true);
    assert.equal(time.pending.size, 2);
    stopAgain();
  });
}

test('installer detection starts only after an explicit opt-in and discards a canceled query', async () => {
  const time = clock(), requests = [], pending = [], output = [];
  const deps = { ...time, settingsReady: false, detectOn: true, api: { invoke: (key) => { requests.push(key); return new Promise((resolve) => pending.push(resolve)); } }, busyRef: { current: '' }, nextWatchDelayMs: () => 3000, document: { hidden: false }, notify: (...args) => output.push(args), setModal: (v) => output.push(v) };
  const node = effect(['settingsReady', 'detectOn']);
  assert.equal(compile(node, deps)(), undefined);
  assert.equal(compile(node, { ...deps, settingsReady: true, detectOn: false })(), undefined);
  assert.deepEqual(requests, []);
  const stop = compile(node, { ...deps, settingsReady: true })();
  assert.deepEqual(requests, ['installers:check']);
  const running = [...time.pending.values()][0]();
  stop();
  pending[1]([{ name: 'fixture' }]);
  await running;
  assert.deepEqual(requests, ['installers:check', 'installers:check']);
  assert.deepEqual(output, []);
  assert.equal(time.pending.size, 0);
});

test('size measurements remain visible while history recording defaults off and cancels a queued write', () => {
  const time = clock(), calls = [];
  let measured;
  const node = nodes.find((n) => n.type === 'CallExpression' && n.callee.name === 'useEffect' && source.slice(...n.arguments[0].range).includes('api.onMeasured')).arguments[0];
  const enabled = { current: false }, sizeTimer = { current: null };
  const deps = { ...time, api: { onMeasured: (fn) => { measured = fn; return () => {}; }, invoke: async (key) => calls.push(key) }, sizeHistoryEnabled: enabled, sizeTimer, measuredTimer: { current: null }, measuredPending: { current: new Map() }, desktopCache: { current: [{ key: 'a' }] }, setRows: () => {}, toRow: (_v, p) => p };
  const stop = compile(node, deps)();
  measured({ key: 'a', sizeKB: 1 });
  assert.equal(sizeTimer.current, null);
  assert.equal(deps.measuredPending.current.size, 1);
  enabled.current = true;
  measured({ key: 'a', sizeKB: 2 });
  const scheduled = time.pending.get(sizeTimer.current);
  enabled.current = false;
  compile(effect(['settingsReady', 'recordSizeHistory']), { ...time, settingsReady: true, recordSizeHistory: false, sizeTimer })();
  scheduled();
  assert.deepEqual(calls, []);
  stop();
  assert.equal(time.pending.size, 0);
});

test('backend samples remain available but resource alerts require a strict saved opt-in', async () => {
  const text = fs.readFileSync(new URL('../src/backend/api.js', import.meta.url), 'utf8');
  const tree = parse(text, { ecmaVersion: 'latest', sourceType: 'module', range: true });
  let handler;
  function find(n) { if (!n || typeof n !== 'object') return; if (n.type === 'Property' && n.key.value === 'processes:sample') handler = n.value; for (const v of Object.values(n)) if (Array.isArray(v)) v.forEach(find); else if (v && typeof v === 'object') find(v); }
  find(tree);
  let enabled, alertCalls = 0;
  const processes = { sample: async () => ({ totals: {}, processes: [{ pid: 1 }] }), alertStates: () => { alertCalls++; return new Set(['cpu']); }, alertText: () => 'hot' };
  const sample = Function('processes', 'readSettings', `let procAlertActive = new Set(); return (${text.slice(...handler.range)});`)(processes, async () => ({ resourceAlerts: enabled }));
  for (enabled of [undefined, false, 'true', 1]) { const r = await sample(); assert.deepEqual(r.alerts, []); assert.equal(r.processes.length, 1); }
  assert.equal(alertCalls, 0);
  enabled = true;
  assert.deepEqual((await sample()).alerts, ['hot']);
  enabled = false;
  assert.deepEqual((await sample()).alerts, []);
  enabled = true;
  assert.deepEqual((await sample()).alerts, ['hot'], 'off clears the fired-alert state');
});
