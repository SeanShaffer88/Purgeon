import assert from 'node:assert/strict';
import { test } from 'node:test';
import { __handlers, mutates } from '../packages/purgeon-core/src/internal/api.js';
import { setSys } from '../src/backend/sys.js';

const advice = {
  status: 'complete',
  packages: [{
    published: 'oem12.inf', provider: 'Fixture', className: 'Net', version: '1.2.3.4',
    bootCritical: false, signature: 2, bindings: { present: 1, nonPresent: 2, unknown: 0 },
  }],
};

test('Driver Retirement Advisor uses only a no-argument read and projects approved fields', async () => {
  const calls = [];
  const forbidden = () => assert.fail('advisor requested a change or elevation');
  setSys({
    driverRetirementAdvisor: async (...args) => {
      calls.push(args);
      return { ...advice, packages: [{ ...advice.packages[0], instanceId: 'PRIVATE-ID', driverId: 'not-an-advisor-grant' }] };
    },
    prepareDriver: forbidden, driverInventory: forbidden, exec: forbidden, launch: forbidden, elevateHandoff: forbidden,
  });
  assert.deepEqual(await __handlers['drivers:advisor']({ driverId: 'untrusted' }), advice);
  assert.deepEqual(calls, [[]]);
  assert.equal(mutates('drivers:advisor'), false);
});


test('partial evidence keeps counts and unknown identities separate from unavailable checks', async () => {
  const row = advice.packages[0];
  const partial = { status: 'partial', packages: [
    { ...row, bindings: { present: 0, nonPresent: 1, unknown: 2 } },
    { ...row, published: 'oem13.inf', bindings: null },
  ] };
  let reply = partial;
  setSys({ driverRetirementAdvisor: async () => reply });
  assert.deepEqual(await __handlers['drivers:advisor'](), partial);
  reply = { status: 'complete', packages: [] };
  assert.deepEqual(await __handlers['drivers:advisor'](), reply);

  const unavailable = { status: 'unavailable', packages: [] };
  for (const result of [
    { status: 'complete', packages: partial.packages },
    { status: 'partial', packages: [row, { ...row, published: 'OEM12.INF' }] },
    { status: 'partial', packages: [{ ...row, published: 'C:\\oem12.inf' }] },
    { status: 'partial', packages: [{ ...row, provider: 'x'.repeat(121) }] },
    { status: 'partial', packages: [{ ...row, className: 'Net\nprivate' }] },
    { status: 'partial', packages: [{ ...row, bindings: { present: 32768, nonPresent: 1, unknown: 0 } }] },
    { status: 'partial', packages: [{ ...row, bindings: { present: -1, nonPresent: 0, unknown: 0 } }] },
    { status: 'partial', packages: Array(513).fill(row) },
    { status: 'unavailable', packages: [row] },
    undefined,
  ]) {
    reply = result;
    assert.deepEqual(await __handlers['drivers:advisor'](), unavailable);
  }
  setSys({ driverRetirementAdvisor: async () => { throw Error('private native failure'); } });
  assert.deepEqual(await __handlers['drivers:advisor'](), unavailable);
  setSys({});
  assert.deepEqual(await __handlers['drivers:advisor'](), unavailable);
});

test('the real desktop advisor adapter uses a separate native command with no arguments', async (t) => {
  const { createTauriSys } = await import('../src/backend/tauri-sys.js');
  for (const key of ['window', '__APP_VERSION__']) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else delete globalThis[key];
    });
  }
  const calls = [];
  globalThis.__APP_VERSION__ = '1.6.1';
  globalThis.window = {
    __TAURI_INTERNALS__: {
      async invoke(command, args) {
        calls.push([command, args]);
        if (command === 'sys_info') return { env: {} };
        if (command === 'driver_inventory') return [];
        assert.equal(command, 'driver_retirement_advisor');
        return advice;
      },
    },
  };
  const adapter = await createTauriSys();
  setSys(adapter);
  assert.deepEqual(await __handlers['drivers:advisor'](), advice);
  assert.deepEqual(await __handlers['drivers:list'](), []);
  assert.deepEqual(calls, [
    ['sys_info', {}], ['driver_retirement_advisor', {}], ['driver_inventory', {}],
  ]);
});

test('device-only advice never promotes a devnode INF to a package identity', async () => {
  const binding = { inf: 'oem12.inf', counts: { present: 1, nonPresent: 0, unknown: 0 } };
  const safe = { status: 'deviceOnly', packages: [], deviceBindings: [binding] };
  let reply = { ...safe, deviceBindings: [{ ...binding, driverId: 'private-grant', instanceId: 'private-device' }] };
  setSys({ driverRetirementAdvisor: async () => reply });
  assert.deepEqual(await __handlers['drivers:advisor'](), safe);
  reply = { status: 'deviceOnly', packages: [] };
  assert.deepEqual(await __handlers['drivers:advisor'](), { ...reply, deviceBindings: [] });
  for (const invalid of [
    { ...safe, packages: advice.packages },
    { ...safe, deviceBindings: [binding, { ...binding, inf: 'OEM12.INF' }] },
    { ...safe, deviceBindings: [{ ...binding, inf: 'C:\\private\\oem12.inf' }] },
    { ...safe, deviceBindings: [{ ...binding, counts: { present: 0, nonPresent: 0, unknown: 0 } }] },
    { ...safe, deviceBindings: [{ ...binding, counts: null }] },
    { ...safe, deviceBindings: Array(513).fill(binding) },
    { ...advice, deviceBindings: [binding] },
  ]) {
    reply = invalid;
    assert.deepEqual(await __handlers['drivers:advisor'](), { status: 'unavailable', packages: [] });
  }
});
