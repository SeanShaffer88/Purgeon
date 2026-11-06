import test from 'node:test';
import assert from 'node:assert/strict';
import { createSecuritySoftwareController, isSecurityRunEligible, securitySoftwareStatus } from '../src/security-software-controller.js';
const product = { id: 'p', name: 'AVG', toolId: 'avg' };
const plan = { id: 'plan', productName: 'AVG', toolName: 'AVG Clear' };
const statusDto = (phase, extra = {}) => ({ id: plan.id, phase, bytesReceived: 0, cancellationRequested: false, cleanup: 'none', detail: '', ...extra });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture(overrides = {}) {
  const calls = [], states = [], errors = [];
  const invoke = async (channel, arg, admission) => {
    calls.push({ channel, arg, admission });
    if (overrides[channel]) return overrides[channel](arg, admission);
    if (channel.endsWith(':list')) return { products: [product], sources: [], complete: true };
    if (channel.endsWith(':prepare')) return plan;
    if (channel.endsWith(':launch')) { await admission.approve(); return { outcome: 'launched' }; }
    if (channel.endsWith(':cancel')) return { accepted: true, status: { phase: 'cancelled' } };
    return statusDto('downloading');
  };
  const controller = createSecuritySoftwareController({ invoke, confirm: async () => true, confirmReview: async () => true, onChange: s => states.push(s), onError: e => errors.push(e), ...overrides.options });
  return { controller, calls, states, errors };
}
test('inventory load and unsupported selection never prepare', async () => {
  const f = fixture(); await f.controller.load(); assert.equal(f.states.at(-1).inventory.products.length, 1);
  await f.controller.run(null); await f.controller.run({ ...product, builtIn: true }); await f.controller.run({ id: 'unknown' });
  assert.equal(f.calls.length, 1); f.controller.dispose();
});
test('all activation paths share synchronous singleflight and admission-backed confirmation', async () => {
  const d = deferred(); const f = fixture({ 'securitySoftware:prepare': () => d.promise });
  const first = f.controller.run(product); await f.controller.run(product); await f.controller.run(product);
  assert.equal(f.calls.length, 1); d.resolve(plan); await first;
  const launch = f.calls.find(c => c.channel.endsWith(':launch'));
  assert.deepEqual(launch.arg, { planId: 'plan' }); assert.equal(launch.admission.requiresApproval, true);
  assert.match(f.states.at(-1).message, /Vendor utility launched/); f.controller.dispose();
});
test('denial cancels inert plan without launching utility', async () => {
  const f = fixture({ options: { confirm: async () => false } }); await f.controller.run(product);
  assert.ok(f.calls.some(c => c.channel.endsWith(':cancel'))); assert.equal(f.states.at(-1).phase, 'cancelled'); f.controller.dispose();
});
test('unmount during prepare cancels late plan and never launches or updates state', async () => {
  const d = deferred(); const f = fixture({ 'securitySoftware:prepare': () => d.promise });
  const run = f.controller.run(product); f.controller.dispose(); const count = f.states.length; d.resolve(plan); await run;
  assert.equal(f.states.length, count); assert.ok(f.calls.some(c => c.channel.endsWith(':cancel'))); assert.ok(!f.calls.some(c => c.channel.endsWith(':launch')));
});
test('lost launch response requires review and blocks automatic repeated launch', async () => {
  const f = fixture({ 'securitySoftware:launch': async (_, a) => { await a.approve(); throw Error('response lost'); } });
  await f.controller.run(product); assert.equal(f.states.at(-1).phase, 'reviewRequired'); await f.controller.run(product);
  assert.equal(f.calls.filter(c => c.channel.endsWith(':prepare')).length, 1); f.controller.dispose();
});

for (const phase of ['failed', 'cancelled']) test(`approved rejection reconciles ${phase} and requires fresh manual preparation and consent`, async () => {
  let confirmations = 0, preparations = 0;
  const f = fixture({ options: { confirm: async () => { confirmations++; return true; } },
    'securitySoftware:prepare': async () => ({ ...plan, id: `plan-${++preparations}` }),
    'securitySoftware:launch': async (_, admission) => { await admission.approve(); throw Error('Approval expired'); },
    'securitySoftware:status': async arg => statusDto(phase, { id: arg.planId, detail: 'Stopped before launch' }),
  });
  await f.controller.run(product);
  assert.equal(f.states.at(-1).phase, phase); assert.equal(f.states.at(-1).message, 'Stopped before launch');
  assert.equal(isSecurityRunEligible(product, f.states.at(-1)), true);
  assert.equal(preparations, 1); assert.equal(confirmations, 1);
  assert.equal(f.calls.filter(c => c.channel.endsWith(':status')).length, 1);
  await f.controller.run(product);
  assert.equal(preparations, 2); assert.equal(confirmations, 2);
  assert.equal(f.calls.filter(c => c.channel.endsWith(':launch')).length, 2);
  assert.equal(f.calls.filter(c => c.channel.endsWith(':status')).length, 2); f.controller.dispose();
});

for (const response of [null, {}, { phase: 'failed' }, statusDto('failed', { id: 'other' }), statusDto('failed', { detail: null }), statusDto('failed', { bytesReceived: -1 }), statusDto('failed', { cleanup: 'unknown' }), statusDto('failed', { cancellationRequested: null }), statusDto('unknown'), ...['prepared', 'downloading', 'verifying', 'launching', 'launched', 'reviewRequired', 'acknowledged'].map(phase => statusDto(phase)), 'unavailable']) {
  test(`untrusted or non-prelaunch reconciliation stays blocked: ${JSON.stringify(response)}`, async () => {
    const f = fixture({
      'securitySoftware:launch': async (_, admission) => { await admission.approve(); throw Error('failed cancelled expired'); },
      'securitySoftware:status': async () => { if (response === 'unavailable') throw Error('status unavailable'); return response; },
    });
    await f.controller.run(product); assert.equal(f.states.at(-1).phase, 'reviewRequired');
    assert.equal(isSecurityRunEligible(product, f.states.at(-1)), false); await f.controller.run(product);
    assert.equal(f.calls.filter(c => c.channel.endsWith(':status')).length, 1);
    assert.equal(f.calls.filter(c => c.channel.endsWith(':launch')).length, 1); f.controller.dispose();
  });
}

for (const rejected of [false, true]) test(`disposed reconciliation discards late ${rejected ? 'failure' : 'success'} and error notification`, async () => {
  const pending = deferred();
  const f = fixture({
    'securitySoftware:launch': async (_, admission) => { await admission.approve(); throw Error('response lost'); },
    'securitySoftware:status': async () => { await pending.promise; if (rejected) throw Error('unavailable'); return statusDto('failed'); },
  });
  const running = f.controller.run(product); await new Promise(r => setImmediate(r));
  assert.equal(f.calls.filter(c => c.channel.endsWith(':status')).length, 1);
  f.controller.dispose(); const count = f.states.length; pending.resolve(); await running;
  assert.equal(f.states.length, count); assert.deepEqual(f.errors, []);
});

test('known prelaunch failure retains inventory review barrier after refresh', async () => {
  const f = fixture({
    'securitySoftware:launch': async (_, admission) => { await admission.approve(); throw Error('expired'); },
    'securitySoftware:status': async () => statusDto('failed', { cleanup: 'retained' }),
    'securitySoftware:list': async () => ({ products: [product], reviews: [{ state: 'unreadable', canAcknowledge: false }] }),
  });
  await f.controller.run(product); await f.controller.load(); await f.controller.run(product);
  assert.equal(isSecurityRunEligible(product, f.states.at(-1)), false);
  assert.equal(f.calls.filter(c => c.channel.endsWith(':prepare')).length, 1); f.controller.dispose();
});

test('old poll cannot overwrite a fresh manual run after rejection reconciliation', async () => {
  const oldPoll = deferred(), rejectedLaunch = deferred(), nextLaunch = deferred(), queued = []; let attempt = 0, queries = 0;
  const f = fixture({ options: { schedule: fn => { queued.push(fn); return queued.length; }, unschedule: () => {} },
    'securitySoftware:prepare': async () => ({ ...plan, id: `plan-${++attempt}` }),
    'securitySoftware:launch': async (_, admission) => { await admission.approve(); if (attempt === 1) { await rejectedLaunch.promise; throw Error('expired'); } return nextLaunch.promise; },
    'securitySoftware:status': arg => ++queries === 1 ? oldPoll.promise : statusDto('failed', { id: arg.planId }),
  });
  const first = f.controller.run(product); await new Promise(r => setImmediate(r)); const polling = queued.shift()();
  rejectedLaunch.resolve(); await first; assert.equal(f.states.at(-1).phase, 'failed');
  const second = f.controller.run(product); await new Promise(r => setImmediate(r));
  oldPoll.resolve(statusDto('launching', { id: 'plan-1' })); await polling;
  assert.equal(f.states.at(-1).phase, 'downloading');
  f.controller.dispose(); nextLaunch.resolve({ outcome: 'cancelled' }); await second;
});

test('cancellation during reconciliation still requires the matching native terminal status', async () => {
  const pending = deferred();
  const f = fixture({ 'securitySoftware:launch': async (_, admission) => { await admission.approve(); throw Error('expired'); },
    'securitySoftware:status': () => pending.promise,
  });
  const running = f.controller.run(product); await new Promise(r => setImmediate(r)); await f.controller.cancel();
  pending.resolve(statusDto('cancelled')); await running;
  assert.equal(f.states.at(-1).phase, 'cancelled'); assert.equal(isSecurityRunEligible(product, f.states.at(-1)), true);
  assert.equal(f.calls.filter(c => c.channel.endsWith(':status')).length, 1); f.controller.dispose();
});
test('inventory error is distinct from an empty successful inventory', async () => {
  const f = fixture({ 'securitySoftware:list': async () => { throw Error('unavailable'); } }); await f.controller.load();
  assert.equal(f.states.at(-1).inventory, null); assert.equal(f.states.at(-1).loading, false); assert.deepEqual(f.errors, ['unavailable']); f.controller.dispose();
});
test('prepare failure reports failure and releases singleflight', async () => {
  const f = fixture({ 'securitySoftware:prepare': async () => { throw Error('prepare failed'); } });
  await f.controller.run(product); await f.controller.run(product); assert.equal(f.calls.length, 2); assert.equal(f.states.at(-1).phase, 'failed'); f.controller.dispose();
});
test('cancel requests native cancellation while launch waits, refusal is explicit', async () => {
  const d = deferred(); const f = fixture({
    'securitySoftware:launch': async (_, a) => { await a.approve(); return d.promise; },
    'securitySoftware:cancel': async () => ({ accepted: false, status: { phase: 'launching', detail: 'Already launching' } }),
  });
  const run = f.controller.run(product); await new Promise(r => setImmediate(r)); await f.controller.cancel();
  assert.match(f.states.at(-1).message, /Already launching/); d.resolve({ outcome: 'launched' }); await run; f.controller.dispose();
});
test('bounded polling stops on terminal status and clears timers on disposal', async () => {
  const d = deferred(), queued = [], cleared = [];
  const f = fixture({ options: { schedule: fn => { queued.push(fn); return queued.length; }, unschedule: id => cleared.push(id) },
    'securitySoftware:launch': async (_, a) => { await a.approve(); return d.promise; },
    'securitySoftware:status': async () => ({ phase: 'verifying', detail: 'Verifying signature' }),
  });
  const run = f.controller.run(product); await new Promise(r => setImmediate(r)); await queued.shift()();
  assert.equal(f.states.at(-1).phase, 'verifying'); assert.equal(queued.length, 1);
  f.controller.dispose(); const count = f.states.length; await queued.shift()(); assert.equal(f.states.length, count);
  d.resolve({ outcome: 'cancelled' }); await run; assert.ok(cleared.length); assert.ok(f.calls.some(c => c.channel.endsWith(':cancel')));
});
test('cancel errors and poll errors are reported without claiming cancellation', async () => {
  const d = deferred(), queued = [];
  const f = fixture({ options: { schedule: fn => { queued.push(fn); return 1; }, unschedule: () => {} },
    'securitySoftware:launch': async (_, a) => { await a.approve(); return d.promise; },
    'securitySoftware:status': async () => { throw Error('status failed'); },
    'securitySoftware:cancel': async () => { throw Error('cancel failed'); },
  });
  const run = f.controller.run(product); await new Promise(r => setImmediate(r)); await queued.shift()(); await f.controller.cancel();
  assert.deepEqual(f.errors, ['status failed', 'cancel failed']); d.resolve({ outcome: 'failed', detail: 'Verification failed' }); await run;
  assert.match(f.states.at(-1).message, /Verification failed/); f.controller.dispose();
});
test('successful cancellation reports native phase; inactive cancel does nothing', async () => {
  const d = deferred(); const f = fixture({ 'securitySoftware:launch': async (_, a) => { await a.approve(); return d.promise; } });
  await f.controller.cancel(); assert.equal(f.calls.length, 0); const run = f.controller.run(product); await new Promise(r => setImmediate(r));
  await f.controller.cancel(); assert.equal(f.states.at(-1).phase, 'cancelled'); d.resolve({ outcome: 'cancelled' }); await run; f.controller.dispose();
});
test('stale inventory responses do not overwrite newer results or update after unmount', async () => {
  const first = deferred(); let n = 0;
  const f = fixture({ 'securitySoftware:list': () => ++n === 1 ? first.promise : { products: [], complete: false } });
  const load = f.controller.load(); await f.controller.load(); first.resolve({ products: [product] }); await load;
  assert.deepEqual(f.states.at(-1).inventory.products, []); f.controller.dispose(); const count = f.states.length; await f.controller.load(); assert.equal(f.states.length, count);
});
test('unmount while confirmation is pending rejects approval and cancels the plan', async () => {
  const d = deferred(); const f = fixture({ options: { confirm: () => d.promise } });
  const run = f.controller.run(product); await new Promise(r => setImmediate(r)); f.controller.dispose(); const count = f.states.length;
  d.resolve(true); await run; assert.equal(f.states.length, count); assert.ok(f.calls.some(c => c.channel.endsWith(':cancel')));
});
test('cancellation during confirmation prevents later positive answer from approving', async () => {
  const d = deferred(); const f = fixture({ options: { confirm: () => d.promise } }); const run = f.controller.run(product);
  await new Promise(r => setImmediate(r)); await f.controller.cancel(); d.resolve(true); await run;
  assert.equal(f.states.at(-1).phase, 'cancelled'); assert.ok(!f.states.some(s => s.phase === 'downloading')); f.controller.dispose();
});
test('unknown launch outcome is held for review', async () => {
  const f = fixture({ 'securitySoftware:launch': async (_, a) => { await a.approve(); return {}; } });
  await f.controller.run(product); assert.equal(f.states.at(-1).phase, 'reviewRequired'); f.controller.dispose();
});

const review = { reviewId: 'review-1', toolId: 'avg', state: 'reviewRequired', detail: 'Previous attempt', canAcknowledge: true };
test('a fresh handoff check is explicit and never removes the pending review barrier', async () => {
  const list = { products: [product], reviews: [review] };
  const observation = { reviewId: review.reviewId, registration: 'notObserved', antivirusHealth: 'poor' };
  const f = fixture({ 'securitySoftware:list': () => list, 'securitySoftware:checkHandoff': () => observation });
  await f.controller.load();
  await f.controller.checkHandoff(review);
  assert.deepEqual(f.states.at(-1).handoff.result, observation);
  assert.equal(isSecurityRunEligible(product, f.states.at(-1)), false);
  assert.deepEqual(f.calls.map(({ channel, arg }) => [channel, arg]), [
    ['securitySoftware:list', undefined], ['securitySoftware:checkHandoff', { reviewId: review.reviewId }],
  ]);
  f.controller.dispose();
});

test('refresh, acknowledgment, and disposal discard an in-flight handoff result', async () => {
  for (const action of ['load', 'acknowledge', 'dispose']) {
    const pending = deferred();
    const f = fixture({
      'securitySoftware:list': () => ({ products: [product], reviews: [review] }),
      'securitySoftware:checkHandoff': () => pending.promise,
      'securitySoftware:acknowledge': async (arg, admission) => {
        await admission.approve();
        return { reviewId: arg.reviewId, outcome: 'acknowledged' };
      },
    });
    await f.controller.load();
    const checking = f.controller.checkHandoff(review);
    await f.controller[action](review);
    const count = f.states.length;
    pending.resolve({ reviewId: review.reviewId, registration: 'observed', antivirusHealth: 'good' });
    await checking;
    assert.equal(f.states.length, count);
    assert.equal(f.states.at(-1).handoff?.result, undefined);
    assert.deepEqual(f.errors, []);
    f.controller.dispose();
  }
});
test('acknowledgment requires admission, clears only after success, refreshes without launching', async () => {
  const f = fixture({ 'securitySoftware:acknowledge': async (arg, admission) => { assert.equal(admission.requiresApproval, true); await admission.approve(); return { reviewId: arg.reviewId, outcome: 'acknowledged' }; } });
  await f.controller.run(product); await f.controller.acknowledge(review);
  assert.deepEqual(f.calls.find(c => c.channel.endsWith(':acknowledge')).arg, { reviewId: 'review-1', acknowledgment: 'reviewedUtilityClosed' });
  assert.equal(f.calls.filter(c => c.channel.endsWith(':launch')).length, 1);
  await f.controller.run(product); assert.equal(f.calls.filter(c => c.channel.endsWith(':prepare')).length, 2); f.controller.dispose();
});
test('denied, stale and unknown acknowledgment responses retain barrier without retry', async () => {
  for (const mode of ['denied', 'stale', 'unknown']) {
    const f = fixture({ options: { confirmReview: async () => mode !== 'denied' }, 'securitySoftware:acknowledge': async (_, admission) => { await admission.approve(); if (mode === 'stale') throw Error('Stale review'); return {}; } });
    await f.controller.run(product); await f.controller.acknowledge(review); await f.controller.run(product);
    assert.equal(f.calls.filter(c => c.channel.endsWith(':prepare')).length, 1);
    assert.equal(f.calls.filter(c => c.channel.endsWith(':acknowledge')).length, 1); f.controller.dispose();
  }
});
test('unreadable recovery records cannot be acknowledged', async () => {
  const unreadable = { ...review, toolId: null, state: 'unreadable', canAcknowledge: false };
  const f = fixture({ 'securitySoftware:list': async () => ({ products: [product], reviews: [unreadable] }) });
  await f.controller.load(); await f.controller.acknowledge(unreadable);
  assert.equal(isSecurityRunEligible(product, f.states.at(-1)), false);
  await f.controller.run(product); await f.controller.run({ ...product, toolId: 'norton' });
  assert.equal(f.calls.length, 1); f.controller.dispose();
});
test('unmount after confirmation cancels downloading but does not cancel launched vendor', async () => {
  const d = deferred(); const f = fixture({ 'securitySoftware:launch': async (_, a) => { await a.approve(); return d.promise; } });
  const run = f.controller.run(product); await new Promise(r => setImmediate(r)); f.controller.dispose();
  assert.ok(f.calls.some(c => c.channel.endsWith(':cancel'))); d.resolve({ outcome: 'launched' }); await run;
  const done = fixture(); await done.controller.run(product); done.controller.dispose(); assert.ok(!done.calls.some(c => c.channel.endsWith(':cancel')));
});

test('restart review blocks all vendors', async () => {
  const f = fixture({ 'securitySoftware:list': async () => ({ products: [product], reviews: [review] }) });
  await f.controller.load(); await f.controller.run(product); assert.equal(f.calls.length, 1);
  await f.controller.run({ ...product, id: 'other', toolId: 'norton' }); assert.equal(f.calls.filter(c => c.channel.endsWith(':prepare')).length, 0); f.controller.dispose();
});

test('old poll and cancel responses cannot overwrite a later download or suppress disposal cancellation', async () => {
  for (const kind of ['poll', 'cancel']) {
    const old = deferred(), launches = [deferred(), deferred()], queued = []; let attempt = 0;
    const f = fixture({ options: { schedule: fn => { queued.push(fn); return queued.length; }, unschedule: () => {} },
      'securitySoftware:prepare': async () => ({ ...plan, id: `plan-${++attempt}` }),
      'securitySoftware:launch': async (_, admission) => { await admission.approve(); return launches[attempt - 1].promise; },
      'securitySoftware:status': () => old.promise,
      'securitySoftware:cancel': arg => arg.planId === 'plan-1' ? old.promise : { accepted: true, status: { phase: 'cancelled' } },
    });
    const first = f.controller.run(product); await new Promise(r => setImmediate(r));
    const pending = kind === 'poll' ? queued.shift()() : f.controller.cancel();
    launches[0].resolve({ outcome: 'cancelled' }); await first;
    const second = f.controller.run(product); await new Promise(r => setImmediate(r));
    old.resolve(kind === 'poll' ? { phase: 'launching' } : { accepted: false, status: { phase: 'launching' } }); await pending;
    assert.equal(f.states.at(-1).phase, 'downloading');
    f.controller.dispose(); assert.ok(f.calls.some(c => c.channel.endsWith(':cancel') && c.arg.planId === 'plan-2'));
    launches[1].resolve({ outcome: 'cancelled' }); await second;
  }
});

test('completed launch exposes global blocked eligibility', async () => {
  const f = fixture(); await f.controller.run(product);
  assert.equal(f.states.at(-1).reviewBlocked, true);
  assert.equal(isSecurityRunEligible(product, f.states.at(-1)), false);
  await f.controller.run({ ...product, toolId: 'other' });
  assert.equal(f.calls.filter(c => c.channel.endsWith(':prepare')).length, 1); f.controller.dispose();
});

test('old timer never queries a new plan and duplicate approval never confirms twice', async () => {
  const queued = []; let confirmations = 0;
  const f = fixture({ options: { schedule: fn => { queued.push(fn); return 1; }, unschedule: () => {}, confirm: async () => { confirmations++; return true; } },
    'securitySoftware:launch': async (_, admission) => { await admission.approve(); await assert.rejects(admission.approve(), /already requested/); return { outcome: 'cancelled' }; },
  });
  await f.controller.run(product); await f.controller.run(product); await queued[0]();
  assert.equal(confirmations, 2); assert.ok(!f.calls.some(c => c.channel.endsWith(':status'))); f.controller.dispose();
});

test('late inventory cannot overwrite a launch status, and footer advances after acknowledgment denial', async () => {
  const inventory = deferred(); let allow = false;
  const f = fixture({ options: { confirmReview: async () => allow },
    'securitySoftware:list': () => inventory.promise,
    'securitySoftware:acknowledge': async (arg, admission) => { await admission.approve(); return { reviewId: arg.reviewId, outcome: 'acknowledged' }; },
  });
  const load = f.controller.load(); await f.controller.acknowledge(review);
  assert.deepEqual(f.errors, ['Acknowledgment cancelled.']);
  allow = true; inventory.resolve({ products: [product], reviews: [], complete: true });
  await f.controller.acknowledge(review); await load;
  assert.match(securitySoftwareStatus(f.states.at(-1), 1), /Previous attempt acknowledged/);
  await f.controller.run(product);
  assert.match(securitySoftwareStatus(f.states.at(-1), 1), /Vendor utility launched/);
  assert.equal(f.states.at(-1).loading, false); f.controller.dispose();
});

test('late acknowledgment and launch receipts cannot publish state after disposal', async () => {
  for (const channel of ['securitySoftware:acknowledge', 'securitySoftware:launch']) {
    const receipt = deferred();
    const f = fixture({ [channel]: async (_, admission) => { await admission.approve(); return receipt.promise; } });
    const running = channel.endsWith(':launch') ? f.controller.run(product) : f.controller.acknowledge(review);
    await new Promise(r => setImmediate(r)); f.controller.dispose(); const count = f.states.length;
    receipt.resolve(channel.endsWith(':launch') ? { outcome: 'launched' } : { reviewId: review.reviewId, outcome: 'acknowledged' }); await running;
    assert.equal(f.states.length, count); assert.deepEqual(f.errors, []);
    assert.ok(!f.calls.some(c => c.channel.endsWith(':list')));
  }
});

test('inventory requested before a run cannot restore obsolete reviews after it', async () => {
  const inventory = deferred(); const f = fixture({ 'securitySoftware:list': () => inventory.promise });
  const loading = f.controller.load(); await f.controller.run(product);
  inventory.resolve({ products: [], reviews: [review] }); await loading;
  assert.equal(f.states.at(-1).inventory, null);
  assert.match(securitySoftwareStatus(f.states.at(-1), 1), /Vendor utility launched/); f.controller.dispose();
});
