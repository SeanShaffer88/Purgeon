// Tests for the disposable isolated test environment for portable packaging.
// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { setSys } from '../src/backend/sys.js';
import { createNodeSys } from './node-sys.js';
import * as monitor from '../src/backend/monitor.js';

const nodeSys = createNodeSys();
setSys(nodeSys);

// Build a mock sys with the functions needed by the disposable test install flow.
function mockSys(overrides = {}) {
  const mock = {
    ...nodeSys,
    dataDir: '/tmp/purgeon-test-disposable',
    info: { ...nodeSys.info, dataDir: '/tmp/purgeon-test-disposable' },
    takeSnapshot: async () => ({ dirs: 0, files: 0, keys: 0, values: 0 }),
    capture: async () => ({ dirs: 0, files: 0, keys: 0, values: 0 }),
    compareSnapshots: async () => ({ added: [], changed: [], removed: [] }),
    trackStart: async () => true,
    trackStop: async () => null,
    trackRunning: async () => false,
    readText: async () => '{}',
    writeText: async () => {},
    writeTextAtomic: async () => {},
    removePath: async () => {},
    exists: async () => false,
    makeDir: async () => {},
    readDir: async () => [],
    stat: async () => null,
    ...overrides,
  };
  setSys(mock);
  return mock;
}

test('testInstallStart takes before snapshot and starts tracking', async () => {
  const mock = mockSys({
    takeSnapshot: async () => ({ dirs: 5, files: 10, keys: 3, values: 2 }),
    trackStart: async () => true,
    writeTextAtomic: async (p, c) => { mock.lastWritePath = p; mock.lastWriteContent = c; },
  });
  const result = await monitor.testInstallStart('C:\\Setup.exe', 'TestApp');
  assert.equal(result.entries, 20, 'should sum all snapshot entries');
  assert.equal(result.live, true, 'should report live tracking');
  assert.ok(mock.lastWritePath.includes('session.json'), 'should write session file');
});

test('testInstallFinish compares snapshots and returns items', async () => {
  const mock = mockSys({
    compareSnapshots: async () => ({
      added: [
        { kind: 'file', path: 'C:\\Program Files\\TestApp\\app.exe' },
        { kind: 'dir', path: 'C:\\Program Files\\TestApp' },
      ],
      changed: [],
      removed: [],
    }),
    trackStop: async () => null,
    writeText: async () => {},
    writeTextAtomic: async () => {},
  });
  const result = await monitor.testInstallFinish('TestApp');
  assert.equal(result.name, 'TestApp');
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].kind, 'file');
  assert.equal(result.items[1].kind, 'dir');
});

test('testInstallFinish keeps temp result for revert', async () => {
  const mock = mockSys({
    compareSnapshots: async () => ({
      added: [{ kind: 'file', path: 'C:\\Program Files\\TestApp\\app.exe' }],
      changed: [],
      removed: [],
    }),
    trackStop: async () => null,
    writeTextAtomic: async (p, c) => { mock.lastWritePath = p; mock.lastWriteContent = c; },
  });
  await monitor.testInstallFinish('TestApp');
  assert.ok(mock.lastWritePath.includes('test-install-last.json'), 'should save temp result file');
  const saved = JSON.parse(mock.lastWriteContent);
  assert.equal(saved.items.length, 1);
});

test('revertTestInstall with no items returns empty', async () => {
  mockSys({ readText: async () => { throw new Error('not found'); } });
  const result = await monitor.revertTestInstall([]);
  assert.equal(result.results.length, 0);
  assert.equal(result.backupId, null);
});

test('classifyForPortable integrates with test install results', async () => {
  const { classifyForPortable } = await import('../src/backend/portableapps.js');
  // Items from a test install of a clean program (no system changes)
  const cleanItems = [
    { kind: 'dir', path: 'C:\\Program Files\\Foo\\Foo' },
    { kind: 'file', path: 'C:\\Program Files\\Foo\\Foo.exe' },
  ];
  const clean = await classifyForPortable(cleanItems);
  assert.equal(clean.portable, true);

  // Items from a test install of a program adding a service
  const serviceItems = [
    { kind: 'dir', path: 'C:\\Program Files\\Foo\\Foo' },
    { kind: 'service', path: 'FooSvc' },
  ];
  const withService = await classifyForPortable(serviceItems);
  assert.equal(withService.portable, false);
  assert.ok(withService.reasons.length > 0);
});

test('testInstallFinish returns portable classification via API handler pattern', async () => {
  const mock = mockSys({
    compareSnapshots: async () => ({
      added: [{ kind: 'file', path: 'C:\\Program Files\\Foo\\Foo.exe' }],
      changed: [],
      removed: [],
    }),
    trackStop: async () => null,
    writeText: async () => {},
    writeTextAtomic: async () => {},
  });
  const result = await monitor.testInstallFinish('Foo');
  // Simulate what the API handler does: classify the items
  const { classifyForPortable } = await import('../src/backend/portableapps.js');
  const suitability = await classifyForPortable(result.items);
  assert.equal(suitability.portable, true, 'single exe in program files should be portable');
  assert.equal(suitability.reasons.length, 0);
});
