import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduledTaskCheck } from '../src/backend/selfhealth.js';

test('a task that is on in settings but missing in Windows fails, with the fix named', () => {
  const c = scheduledTaskCheck('mainttask', 'Weekly maintenance task', 'Weekly Maintenance', true, { registered: false });
  assert.equal(c.status, 'fail');
  assert.match(c.detail, /turn Weekly Maintenance off and on again/);
});

test('a leftover task while the setting is off warns', () => {
  const c = scheduledTaskCheck('mainttask', 'Weekly maintenance task', 'Weekly Maintenance', false, { registered: true });
  assert.equal(c.status, 'warn');
});

test('off and unregistered is a plain pass', () => {
  const c = scheduledTaskCheck('bgtask', 'Background monitoring task', 'Background Monitoring', false, { registered: false });
  assert.deepEqual([c.status, c.detail], ['pass', 'Off.']);
});

test('a registered task that ran cleanly passes and reports the run', () => {
  const c = scheduledTaskCheck('bgtask', 'Background monitoring task', 'Background Monitoring', true, {
    registered: true,
    lastRun: '2026-11-01T10:00:00.000Z',
    lastResult: 0,
    nextRun: '2026-11-02T10:00:00.000Z',
  });
  assert.equal(c.status, 'pass');
  assert.match(c.detail, /finished cleanly/);
});

test('a registered task whose last run failed warns with the result code', () => {
  const c = scheduledTaskCheck('bgtask', 'Background monitoring task', 'Background Monitoring', true, {
    registered: true,
    lastRun: '2026-11-01T10:00:00.000Z',
    lastResult: 1,
  });
  assert.equal(c.status, 'warn');
  assert.match(c.detail, /result 1/);
});

test('a registered task that has not run yet passes without inventing a result', () => {
  const c = scheduledTaskCheck('bgtask', 'Background monitoring task', 'Background Monitoring', true, { registered: true, lastRun: '', nextRun: '' });
  assert.equal(c.status, 'pass');
  assert.match(c.detail, /Has not run yet/);
});
