// Processes view: the pure parts — CPU maths between samples, the critical-
// process guard, the alert dead band, and the affinity mask.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpuPercents, guardReason, alertStates, affinityMask, CRITICAL_NAMES } from '../src/backend/processes.js';

test('cpu percent is the change between samples over total capacity', () => {
  const prev = [{ pid: 1, cpuSeconds: 10 }, { pid: 2, cpuSeconds: 5 }];
  const now = [{ pid: 1, cpuSeconds: 11 }, { pid: 2, cpuSeconds: 5 }, { pid: 3, cpuSeconds: 2 }];
  const pcts = cpuPercents(prev, now, 2000, 4); // 2 seconds, 4 cores
  assert.equal(pcts.get(1), 12.5); // 1s of CPU in 2s across 4 cores
  assert.equal(pcts.get(2), 0);
  assert.equal(pcts.get(3), 0); // new process: no baseline yet
  assert.equal(cpuPercents(null, now, 2000, 4).size, 0);
});

test('critical processes, Purgeon itself and pid 0/4 are guarded', () => {
  for (const name of ['csrss', 'lsass.exe', 'System']) {
    assert.ok(guardReason({ pid: 500, name }), name);
  }
  assert.ok(CRITICAL_NAMES.has('svchost'));
  assert.ok(guardReason({ pid: 900, name: 'purgeon' }));
  assert.ok(guardReason({ pid: 0, name: 'Idle' }));
  assert.ok(guardReason({ pid: 4, name: 'System' }));
  assert.equal(guardReason({ pid: 1234, name: 'chrome' }), null);
  assert.ok(guardReason({ pid: -1, name: 'chrome' }));
});

test('alerts fire at the threshold and clear below the dead band', () => {
  const th = { cpu: 90, mem: 90, diskFreeGB: 20 };
  const hot = { cpuPct: 95, memPct: 50, systemFreeGB: 100, systemDrive: 'C:' };
  let active = alertStates(hot, th, new Set());
  assert.deepEqual([...active], ['cpu']);
  const warm = { ...hot, cpuPct: 89 }; // inside the 2-point dead band: still firing
  active = alertStates(warm, th, active);
  assert.deepEqual([...active], ['cpu']);
  const cool = { ...hot, cpuPct: 80 };
  active = alertStates(cool, th, active);
  assert.equal(active.size, 0);
  const lowDisk = { ...cool, systemFreeGB: 12 };
  active = alertStates(lowDisk, th, active);
  assert.deepEqual([...active], ['disk']);
  const off = alertStates(lowDisk, { cpu: 0, mem: 0, diskFreeGB: 0 }, active);
  assert.equal(off.size, 0); // thresholds at 0 turn alerts off
});

test('affinity mask sets exactly the chosen cores', () => {
  assert.equal(affinityMask([0, 2]), 0b101n);
  assert.equal(affinityMask([]), 0n);
  assert.equal(affinityMask([63]), 1n << 63n);
  assert.equal(affinityMask([64, -1]), 0n);
});
