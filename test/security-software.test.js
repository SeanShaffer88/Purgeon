import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setSys } from '../src/backend/sys.js';
import * as security from '../src/backend/security-software.js';
import { api } from '../src/backend/api.js';
import { securitySoftwareAdapter } from '../src/backend/tauri-sys.js';
const productId = 'a'.repeat(32), planId = 'b'.repeat(32);
const plan = { id: planId, productId, toolId: 'avg', productName: 'AVG', toolName: 'AVG Clear', recoveryLimits: 'No rollback', expiresAt: '2026-11-04T20:00:00Z' };
const status = { id: planId, phase: 'prepared', bytesReceived: 0, cancellationRequested: false, cleanup: 'none', detail: 'Ready' };
const inventory = { reviews: [], products: [{ id: productId, name: 'AVG', publisher: 'AVG Technologies', version: '1', sources: ['registry'], category: 'antivirus', toolId: 'avg', unsupportedReason: null, builtIn: false, helpUrl: null }], sources: [{ id: 'registry', status: 'ok', detail: '' }], complete: true, observedAt: '2026-11-04T19:00:00Z' };
test('handoff check sends only the review identity and validates independent native observations', async () => {
  const reviewId = 'c'.repeat(32);
  const observation = { reviewId, productName: null, registration: 'unknown', antivirusHealth: 'good', observedAt: inventory.observedAt };
  const calls = fixture({ checkSecuritySoftwareHandoff: async request => { calls.push(request); return { ...observation, payload: 'private' }; } });
  assert.deepEqual(await api.invoke('securitySoftware:checkHandoff', { reviewId }), observation);
  assert.deepEqual(calls, [{ reviewId }]);
  for (const bad of [{ reviewId, path: 'private' }, { reviewId: '../fixture' }, null]) {
    await assert.rejects(security.checkHandoff(bad), /Invalid security-software request/);
  }
  assert.equal(calls.length, 1);
  for (const patch of [{ reviewId: planId }, { registration: 'removed' }, { antivirusHealth: 'protected' }, { productName: {} }, { observedAt: 'invalid' }]) {
    fixture({ checkSecuritySoftwareHandoff: async () => ({ ...observation, ...patch }) });
    await assert.rejects(security.checkHandoff({ reviewId }), /invalid security-software response/i);
  }
  const binding = securitySoftwareAdapter((...args) => args);
  assert.deepEqual(binding.checkSecuritySoftwareHandoff({ reviewId }), ['check_security_software_handoff', { request: { reviewId } }]);
});
function fixture(overrides = {}) {
  const calls = [];
  setSys({ securitySoftwareInventory: async () => { calls.push('list'); return inventory; },
    prepareSecuritySoftwareRemoval: async request => { calls.push(['prepare', request]); return plan; },
    launchSecuritySoftwareRemoval: async id => { calls.push(['launch', id]); return { id, outcome: 'launched', detail: 'Vendor utility launched' }; },
    cancelSecuritySoftwareRemoval: async id => { calls.push(['cancel', id]); return { accepted: true, status: { ...status, phase: 'cancelled' } }; },
    securitySoftwareRemovalStatus: async id => { calls.push(['status', id]); return status; }, ...overrides });
  return calls;
}
test('inventory and inert preparation expose only validated native metadata', async () => {
  const calls = fixture();
  assert.deepEqual(await security.list(), inventory);
  assert.deepEqual(await security.prepare({ productId }), plan);
  assert.deepEqual(calls, ['list', ['prepare', { productId }]]);
});
test('closed requests reject malformed IDs and renderer execution metadata before native calls', async () => {
  const calls = fixture();
  for (const operation of [security.prepare, security.launch, security.cancel, security.status]) {
    const key = operation === security.prepare ? 'productId' : 'planId';
    for (const arg of [undefined, null, [], {}, { [key]: '../evil' }, { [key]: '' }, { [key]: planId, url: 'https://evil.test' }, { [key]: planId, approved: true }]) await assert.rejects(() => operation(arg), /Invalid/);
  }
  await assert.rejects(() => security.list({ path: 'x' }), /Invalid/);
  assert.deepEqual(calls, []);
});
test('launch requires admission and denial reaches no native operation', async () => {
  const calls = fixture();
  for (const admission of [undefined, {}, { requiresApproval: false, approve: async () => {} }, { requiresApproval: true }]) await assert.rejects(() => api.invoke('securitySoftware:launch', { planId }, admission), /approval/i);
  await assert.rejects(() => api.invoke('securitySoftware:launch', { planId }, { requiresApproval: true, approve: async () => { throw new Error('Denied'); } }), /Denied/);
  assert.deepEqual(calls, []);
});
test('approval reserves mutation admission while list, prepare, cancel and status remain concurrent', async () => {
  const calls = fixture(); let release, approvals = 0;
  const pending = api.invoke('securitySoftware:launch', { planId }, { requiresApproval: true, approve: () => { approvals++; return new Promise(resolve => { release = resolve; }); } });
  await assert.rejects(() => api.invoke('securitySoftware:launch', { planId }, { requiresApproval: true, approve: async () => {} }), /Another operation/);
  await assert.rejects(() => api.invoke('settings:set', {}), /Another operation/);
  await api.invoke('securitySoftware:list');
  await api.invoke('securitySoftware:prepare', { productId });
  assert.equal((await api.invoke('securitySoftware:cancel', { planId })).accepted, true);
  assert.deepEqual(await api.invoke('securitySoftware:status', { planId }), status);
  release();
  assert.equal((await pending).outcome, 'launched');
  assert.equal(approvals, 1);
  assert.equal(calls.filter(call => call[0] === 'launch').length, 1);
});
test('unknown native responses fail closed and launch errors never retry', async () => {
  for (const [method, operation, arg] of [['securitySoftwareInventory', security.list, undefined], ['prepareSecuritySoftwareRemoval', security.prepare, { productId }], ['launchSecuritySoftwareRemoval', security.launch, { planId }], ['cancelSecuritySoftwareRemoval', security.cancel, { planId }], ['securitySoftwareRemovalStatus', security.status, { planId }]]) {
    for (const value of [null, {}, { ...status, phase: 'removed' }]) {
      fixture({ [method]: async () => value });
      await assert.rejects(() => operation(arg), /invalid security-software response/i);
    }
  }
  let attempts = 0;
  fixture({ launchSecuritySoftwareRemoval: async () => { attempts++; throw new Error('file busy after acceptance'); } });
  await assert.rejects(() => api.invoke('securitySoftware:launch', { planId }, { requiresApproval: true, approve: async () => {} }), /file busy/);
  assert.equal(attempts, 1);
});
test('approval cannot change the admitted launch plan', async () => {
  const calls = fixture();
  const argument = { planId };
  await api.invoke('securitySoftware:launch', argument, { requiresApproval: true, approve: async () => { argument.planId = 'c'.repeat(32); } });
  assert.deepEqual(calls, [['launch', planId]]);
});
test('Tauri bindings use only dedicated commands and closed native request objects', async () => {
  const calls = [];
  const adapter = securitySoftwareAdapter(async (...args) => { calls.push(args); return { native: true }; });
  assert.deepEqual(await adapter.securitySoftwareInventory(), { native: true });
  await adapter.acknowledgeSecuritySoftwareRemoval({ reviewId: planId, acknowledgment: 'reviewedUtilityClosed' });
  await adapter.prepareSecuritySoftwareRemoval({ productId });
  await adapter.launchSecuritySoftwareRemoval(planId);
  await adapter.cancelSecuritySoftwareRemoval(planId);
  await adapter.securitySoftwareRemovalStatus(planId);
  assert.deepEqual(calls, [['security_software_inventory'], ['acknowledge_security_software_removal', { request: { reviewId: planId, acknowledgment: 'reviewedUtilityClosed' } }], ['prepare_security_software_removal', { request: { productId } }], ['launch_security_software_removal', { request: { planId } }], ['cancel_security_software_removal', { request: { planId } }], ['security_software_removal_status', { request: { planId } }]]);
});
test('partial sources, unsupported products and output sanitization preserve unknown evidence', async () => {
  const value = structuredClone(inventory);
  value.complete = false;
  value.sources = [{ id: 'WMI', status: 'unavailable', detail: 'Unavailable class' }, { id: 'HKCU32', status: 'error', detail: 'Denied' }];
  value.products[0] = { ...value.products[0], toolId: null, builtIn: true, unsupportedReason: 'Built in', path: 'C:\\do-not-expose' };
  fixture({ securitySoftwareInventory: async () => value, prepareSecuritySoftwareRemoval: async () => ({ ...plan, path: 'secret' }) });
  const result = await security.list();
  assert.equal(result.complete, false);
  assert.equal(result.products[0].toolId, null);
  assert.equal(result.products[0].path, undefined);
  assert.equal((await security.prepare({ productId })).path, undefined);
  result.products[0].sources.push('renderer');
  assert.deepEqual(value.products[0].sources, ['registry']);
});
test('malformed native fields and mismatched receipts fail closed', async () => {
  for (const field of [{ products: null }, { sources: null }, { complete: 'yes' }, { observedAt: 'bad' }, { products: [{ ...inventory.products[0], id: 'x' }] }, { products: [{ ...inventory.products[0], toolId: 'invented' }] }, { sources: [{ id: 'x', status: 'unknown', detail: '' }] }]) {
    fixture({ securitySoftwareInventory: async () => ({ ...inventory, ...field }) });
    await assert.rejects(security.list(), /invalid security-software response/i);
  }
  for (const field of [{ id: 'x' }, { productId: 'c'.repeat(32) }, { toolId: 'invented' }, { expiresAt: '' }, { productName: null }]) {
    fixture({ prepareSecuritySoftwareRemoval: async () => ({ ...plan, ...field }) });
    await assert.rejects(security.prepare({ productId }), /invalid security-software response/i);
  }
  for (const field of [{ id: 'x' }, { bytesReceived: -1 }, { cancellationRequested: null }, { cleanup: 'unknown' }, { detail: null }]) {
    fixture({ securitySoftwareRemovalStatus: async () => ({ ...status, ...field }) });
    await assert.rejects(security.status({ planId }), /invalid security-software response/i);
  }
});
test('all declared lifecycle outcomes remain distinct and cancellation can be refused', async () => {
  for (const phase of ['prepared', 'downloading', 'verifying', 'launching', 'launched', 'cancelled', 'failed', 'reviewRequired', 'acknowledged']) {
    fixture({ securitySoftwareRemovalStatus: async () => ({ ...status, phase }) });
    assert.equal((await security.status({ planId })).phase, phase);
  }
  for (const outcome of ['launched', 'cancelled', 'failed', 'reviewRequired']) {
    fixture({ launchSecuritySoftwareRemoval: async () => ({ id: planId, outcome, detail: 'Observed outcome', path: 'hidden' }) });
    assert.deepEqual(await security.launch({ planId }), { id: planId, outcome, detail: 'Observed outcome' });
  }
  fixture({ cancelSecuritySoftwareRemoval: async () => ({ accepted: false, status: { ...status, phase: 'launching', cleanup: 'retained' } }) });
  assert.equal((await security.cancel({ planId })).accepted, false);
});
test('cancellation bypasses a running native launch without releasing mutation admission', async () => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  fixture({ launchSecuritySoftwareRemoval: async () => { entered(); return new Promise(resolve => { release = resolve; }); } });
  const pending = api.invoke('securitySoftware:launch', { planId }, { requiresApproval: true, approve: async () => {} });
  await started;
  assert.equal((await api.invoke('securitySoftware:cancel', { planId })).accepted, true);
  await api.invoke('securitySoftware:status', { planId });
  await assert.rejects(() => api.invoke('settings:set', {}), /Another operation/);
  release({ id: planId, outcome: 'cancelled', detail: 'Cancelled before launch' });
  assert.equal((await pending).outcome, 'cancelled');
});
test('accessors, symbols, nonenumerable extra keys and wrong native IDs are rejected', async () => {
  const accessor = Object.defineProperty({}, 'planId', { get() { throw new Error('Must not execute'); } });
  for (const arg of [accessor, Object.assign({ planId }, { [Symbol('extra')]: true }), Object.defineProperty({ planId }, 'hidden', { value: true }), { planId: 'b'.repeat(64) }]) await assert.rejects(security.status(arg), /Invalid/);
  fixture({ launchSecuritySoftwareRemoval: async () => ({ id: 'c'.repeat(32), outcome: 'launched', detail: '' }), cancelSecuritySoftwareRemoval: async () => ({ accepted: true, status: { ...status, id: 'c'.repeat(32) } }) });
  await assert.rejects(security.launch({ planId }), /invalid security-software response/i);
  await assert.rejects(security.cancel({ planId }), /invalid security-software response/i);
});
test('acknowledgment requires admission, closed arguments and matching native receipt', async () => {
  const reviewId = 'c'.repeat(32), argument = { reviewId, acknowledgment: 'reviewedUtilityClosed' };
  let calls = 0;
  fixture({ acknowledgeSecuritySoftwareRemoval: async value => { calls++; return { reviewId: value.reviewId, outcome: 'acknowledged' }; } });
  for (const admission of [undefined, {}, { requiresApproval: false, approve: async () => {} }, { requiresApproval: true }]) await assert.rejects(() => api.invoke('securitySoftware:acknowledge', argument, admission), /approval/i);
  await assert.rejects(() => api.invoke('securitySoftware:acknowledge', argument, { requiresApproval: true, approve: async () => { throw new Error('Denied'); } }), /Denied/);
  for (const bad of [{ ...argument, acknowledgment: 'removed' }, { ...argument, path: 'x' }, { ...argument, reviewId: '../x' }]) await assert.rejects(() => security.acknowledge(bad), /Invalid/);
  assert.equal(calls, 0);
  assert.deepEqual(await api.invoke('securitySoftware:acknowledge', argument, { requiresApproval: true, approve: async () => { argument.reviewId = 'd'.repeat(32); } }), { reviewId, outcome: 'acknowledged' });
  assert.equal(calls, 1);
  fixture({ acknowledgeSecuritySoftwareRemoval: async () => ({ reviewId: 'e'.repeat(32), outcome: 'acknowledged' }) });
  await assert.rejects(() => security.acknowledge({ reviewId, acknowledgment: 'reviewedUtilityClosed' }), /invalid security-software response/i);
});
test('inventory validates review identities, exact tools, states and fixed help URLs', async () => {
  const review = { reviewId: 'c'.repeat(32), toolId: 'avg', planId, state: 'reviewRequired', detail: 'Review utility', canAcknowledge: true };
  fixture({ securitySoftwareInventory: async () => ({ ...inventory, reviews: [review] }) });
  assert.deepEqual((await security.list()).reviews, [review]);
  const unreadable = { ...review, toolId: null, planId: null, state: 'unreadable', canAcknowledge: false };
  fixture({ securitySoftwareInventory: async () => ({ ...inventory, reviews: [unreadable] }) });
  assert.deepEqual((await security.list()).reviews, [unreadable]);
  for (const patch of [{ reviewId: '../x' }, { toolId: 'eset' }, { toolId: null }, { planId: null }, { planId: 'x' }, { state: 'removed' }, { detail: null }, { canAcknowledge: 'true' }, { state: 'unreadable', canAcknowledge: true }, { toolId: null, state: 'unreadable', canAcknowledge: true }]) {
    fixture({ securitySoftwareInventory: async () => ({ ...inventory, reviews: [{ ...review, ...patch }] }) });
    await assert.rejects(security.list(), /invalid security-software response/i);
  }
  fixture({ securitySoftwareInventory: async () => ({ ...inventory, products: [{ ...inventory.products[0], helpUrl: 'https://evil.test' }] }) });
  await assert.rejects(security.list(), /invalid security-software response/i);
  const helpUrl = 'https://support.eset.com/en/kb2289-uninstall-eset-manually-using-the-eset-uninstaller-tool';
  fixture({ securitySoftwareInventory: async () => ({ ...inventory, products: [{ ...inventory.products[0], helpUrl }] }) });
  assert.equal((await security.list()).products[0].helpUrl, helpUrl);
});

test('acknowledgment propagates native replay errors without retries or other effects', async () => {
  let attempts = 0;
  const calls = fixture({ acknowledgeSecuritySoftwareRemoval: async () => { attempts++; throw new Error('file busy: stale review'); } });
  await assert.rejects(() => api.invoke('securitySoftware:acknowledge', { reviewId: 'c'.repeat(32), acknowledgment: 'reviewedUtilityClosed' }, { requiresApproval: true, approve: async () => {} }), /stale review/);
  assert.equal(attempts, 1);
  assert.deepEqual(calls, []);
});

 test('status remains valid after acknowledgment consumes a plan', async () => {
  let phase = 'reviewRequired';
  fixture({
    acknowledgeSecuritySoftwareRemoval: async ({ reviewId }) => { phase = 'acknowledged'; return { reviewId, outcome: 'acknowledged' }; },
    securitySoftwareRemovalStatus: async () => ({ ...status, phase, cleanup: 'retained' }),
  });
  await security.acknowledge({ reviewId: planId, acknowledgment: 'reviewedUtilityClosed' });
  assert.equal((await security.status({ planId })).phase, 'acknowledged');
});
