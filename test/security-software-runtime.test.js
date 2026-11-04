import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerRuntime, initializeRuntime } from '../packages/purgeon-core/src/public-runtime.js';
import * as av from '../packages/purgeon-core/src/features/securitySoftware.js';

test('public facade uses real approval and permits concurrent cancellation while native launch runs', async () => {
  const productId = 'a'.repeat(32), planId = 'b'.repeat(32);
  let approved = false, approvals = 0, acknowledgments = 0, launches = 0, release, entered;
  const status = { id: planId, phase: 'downloading', bytesReceived: 1, cancellationRequested: false, cleanup: 'pending', detail: 'Fixture' };
  const inventory = { products: [], reviews: [], sources: [], complete: true, observedAt: '2026-11-04T19:00:00Z' };
  const plan = { id: planId, productId, toolId: 'avg', productName: 'Fixture product', toolName: 'Fixture utility', recoveryLimits: 'No rollback', expiresAt: '2026-11-04T20:00:00Z' };
  await assert.rejects(av.list(), /not ready/);
  registerRuntime({ host: {
    info: { dataDir: 'C:\\InertAvFixture', env: {}, home: 'C:\\InertAvFixture', exe: '', version: 'test' },
    makeDir: async () => {}, readDir: async () => [], readText: async () => { throw new Error('missing'); },
    readOptionalText: async () => null, writeTextAtomic: async () => {}, appendText: async () => {}, stat: async () => null,
    acknowledgeSecuritySoftwareRemoval: async request => { acknowledgments++; return { reviewId: request.reviewId, outcome: 'acknowledged' }; },
    securitySoftwareInventory: async () => inventory,
    prepareSecuritySoftwareRemoval: async () => plan,
    launchSecuritySoftwareRemoval: async () => { launches++; entered(); return new Promise(resolve => { release = resolve; }); },
    cancelSecuritySoftwareRemoval: async () => ({ accepted: true, status: { ...status, phase: 'cancelled', cancellationRequested: true } }),
    securitySoftwareRemovalStatus: async () => status,
  }, confirm: async () => { approvals++; return approved; } });
  await initializeRuntime();
  assert.deepEqual(await av.list(), inventory);
  assert.deepEqual(await av.prepare({ productId }), plan);
  assert.equal(approvals, 0);
  await assert.rejects(av.launch({ planId }), /Explicit approval/);
  assert.equal(launches, 0);
  await assert.rejects(av.acknowledge({ reviewId: planId, acknowledgment: 'reviewedUtilityClosed' }), /Explicit approval/);
  assert.equal(acknowledgments, 0);
  approved = true;
  const started = new Promise(resolve => { entered = resolve; });
  const pending = av.launch({ planId });
  await started;
  await assert.rejects(av.launch({ planId }), /Another operation/);
  await assert.rejects(av.acknowledge({ reviewId: planId, acknowledgment: 'reviewedUtilityClosed' }), /Another operation/);
  assert.equal((await av.cancel({ planId })).accepted, true);
  assert.deepEqual(await av.status({ planId }), status);
  assert.deepEqual(await av.list(), inventory);
  assert.deepEqual(await av.prepare({ productId }), plan);
  assert.equal(approvals, 3, 'two denials and exactly one admitted launch approval');
  release({ id: planId, outcome: 'reviewRequired', detail: 'Review vendor windows' });
  assert.equal((await pending).outcome, 'reviewRequired');
  assert.equal(launches, 1);
  assert.deepEqual(await av.acknowledge({ reviewId: planId, acknowledgment: 'reviewedUtilityClosed' }), { reviewId: planId, outcome: 'acknowledged' });
  assert.equal(acknowledgments, 1);
  assert.equal(approvals, 4);
});
