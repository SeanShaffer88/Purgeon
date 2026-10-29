// Health Check: the verdict helpers (DISM wording, thresholds, summary).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDism, freeSpaceStatus, batteryWearStatus, summarize } from '../src/backend/health.js';

test('DISM answers map to the right statuses', () => {
  assert.equal(parseDism('No component store corruption detected.').status, 'pass');
  assert.equal(parseDism('The component store is repairable.').status, 'warn');
  assert.equal(parseDism('Error: 740 Elevated permissions are required').status, 'unknown');
  assert.equal(parseDism('something else entirely').status, 'unknown');
});

test('free space and battery wear thresholds', () => {
  assert.equal(freeSpaceStatus(50).status, 'pass');
  assert.equal(freeSpaceStatus(7).status, 'warn');
  assert.equal(freeSpaceStatus(2).status, 'fail');
  assert.equal(freeSpaceStatus(null).status, 'unknown');
  assert.equal(batteryWearStatus(5).status, 'pass');
  assert.equal(batteryWearStatus(30).status, 'warn');
  assert.equal(batteryWearStatus(55).status, 'fail');
  assert.equal(batteryWearStatus(null).status, 'unknown');
});

test('the summary takes the worst real verdict and ignores unknowns unless nothing ran', () => {
  assert.equal(summarize([{ status: 'pass' }, { status: 'warn' }]).level, 'warn');
  assert.equal(summarize([{ status: 'pass' }, { status: 'fail' }]).level, 'fail');
  assert.equal(summarize([{ status: 'pass' }, { status: 'unknown' }]).level, 'pass');
  assert.equal(summarize([{ status: 'unknown' }]).level, 'unknown');
});
