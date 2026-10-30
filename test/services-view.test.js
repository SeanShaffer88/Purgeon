import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parse } from 'espree';
const source = fs.readFileSync(new URL('../src/startup.jsx', import.meta.url), 'utf8');
const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true }, range: true });
const component = ast.body.find((n) => n.declaration?.id?.name === 'StartupView').declaration;
const declaration = (name, body = component.body.body) => body.flatMap((n) => n.declarations || []).find((n) => n.id.name === name)?.init;
const filterNode = declaration('entriesForMode', ast.body);
const entriesForMode = Function(`return (${source.slice(...filterNode.range)});`)();
const compile = (node, deps) => Function(...Object.keys(deps), `return (${source.slice(...node.range)});`)(...Object.values(deps));
const entries = [{ id: 's', type: 'service' }, { id: 'r', type: 'run' }, { id: 'f', type: 'folder' }, { id: 't', type: 'task' }];

test('actual Startup load partitions before downstream effects and rejects stale responses', async () => {
  for (const mode of ['startup', 'services']) {
    const pending = [], output = [], errors = [];
    const alive = { current: true }, loadGeneration = { current: 0 };
    const load = compile(declaration('load'), { alive, loadGeneration, mode, entriesForMode, api: { invoke: (channel) => { assert.equal(channel, 'startup:list'); return new Promise((resolve, reject) => pending.push({ resolve, reject })); } }, setEntries: (value) => output.push(value), onError: (value) => errors.push(value) });
    const first = load(), second = load();
    pending[1].resolve(entries);
    await second;
    assert.deepEqual(output[0].map((e) => e.id), mode === 'services' ? ['s'] : ['r', 'f', 't']);
    pending[0].reject(Error('stale'));
    await first;
    assert.deepEqual(errors, []);
    const detached = load();
    alive.current = false;
    pending[2].resolve(entries);
    await detached;
    assert.equal(output.length, 1);
  }
});

test('each mode loads one inventory; Services omits inbound firewall reads and detached metadata', async () => {
  const effect = component.body.body.find((n) => n.type === 'ExpressionStatement' && n.expression.callee?.name === 'useEffect').expression.arguments[0];
  for (const servicesOnly of [false, true]) {
    const requests = [], pending = [], output = [];
    let loads = 0;
    const alive = { current: true }, loadGeneration = { current: 0 };
    const stop = compile(effect, { alive, loadGeneration, servicesOnly, load: () => { loads++; }, api: { invoke: (channel) => { requests.push(channel); return new Promise((resolve) => pending.push(resolve)); } }, setBoot: (value) => output.push(value), setInbound: (value) => output.push(value) })();
    assert.equal(loads, 1);
    assert.deepEqual(requests, servicesOnly ? ['running:bootImpact'] : ['running:bootImpact', 'running:inbound']);
    stop(); pending.forEach((resolve) => resolve([]));
    await new Promise(setImmediate);
    assert.deepEqual(output, []);
    assert.equal(alive.current, false);
  }
});

test('Services preserves existing administrator and Windows confirmation guards without mutation', async () => {
  const node = declaration('toggle');
  const calls = [], errors = [];
  const deps = { working: new Set(), admin: false, alive: { current: true }, api: { invoke: async (key) => { calls.push(key); return false; } }, onError: (value) => errors.push(value), tx: (value) => value, setWorking: () => {}, setPending: () => {}, load: () => {} };
  await compile(node, deps)({ ...entries[0], admin: true, name: 'Service' });
  assert.equal(errors.length, 1); assert.deepEqual(calls, []);
  await compile(node, { ...deps, admin: true })({ ...entries[0], enabled: true, windows: true, name: 'Windows Service' });
  assert.deepEqual(calls, ['dialog:confirm']);
});

test('App routes one keyed component per Startup/Services mode and moves one existing label toggle beside Groups', () => {
  const app = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /view === 'startup' \|\| view === 'services'/);
  assert.match(app, /key=\{`\$\{view\}:\$\{customKey\}`\}\s+mode=\{view\}/);
  assert.match(app, /\['startup', 'services'\]\.includes\(view\)/);
  assert.equal((app.match(/className="nav-label-toggle"/g) || []).length, 1);
  const controls = app.slice(app.indexOf('className="group-controls"'), app.indexOf('className="group-controls"') + 900);
  assert.ok(/className="group-controls">\s*<button className="nav-label-toggle"[\s\S]*?aria-pressed=\{navLabels\}[\s\S]*?setNavLabels\(\(value\) => !value\)[\s\S]*?>☰<\/button>\s*<select/.test(controls));
});
