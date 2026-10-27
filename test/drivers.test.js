// Tests for the driver store clean-up logic.
// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { findOldDriverCandidates } from '../src/backend/drivers.js';

const driver = (inf, date) => ({ InfFile: inf, Date: date, Provider: 'Acme Corp' });

test('no drivers means no candidates', () => {
  assert.deepEqual(findOldDriverCandidates([]), []);
});

test('a single driver per inf is never a candidate', () => {
  const drivers = [driver('foo.inf', '2026-01-01'), driver('bar.inf', '2026-02-01')];
  assert.deepEqual(findOldDriverCandidates(drivers), []);
});

test('duplicate infs: all but the newest are candidates', () => {
  const drivers = [
    driver('foo.inf', '2026-01-01'), // old
    driver('foo.inf', '2026-06-01'), // newest
    driver('bar.inf', '2026-03-01'), // single, not a candidate
  ];
  const out = findOldDriverCandidates(drivers);
  assert.equal(out.length, 1);
  assert.equal(out[0].Date, '2026-01-01');
  assert.equal(out[0].InfFile, 'foo.inf');
});

test('multiple old versions: all but newest are candidates', () => {
  const drivers = [
    driver('foo.inf', '2026-01-01'), // oldest
    driver('foo.inf', '2026-02-01'), // middle
    driver('foo.inf', '2026-03-01'), // newest
  ];
  const out = findOldDriverCandidates(drivers);
  assert.equal(out.length, 2);
  // Candidates are newest-first among the duplicates (matching the descending sort)
  assert.equal(out[0].Date, '2026-02-01');
  assert.equal(out[1].Date, '2026-01-01');
});

test('drivers without an InfFile are skipped', () => {
  const drivers = [
    { Date: '2026-01-01', Provider: 'Acme' }, // no InfFile
    driver('foo.inf', '2026-01-01'),
    driver('foo.inf', '2026-02-01'),
  ];
  const out = findOldDriverCandidates(drivers);
  assert.equal(out.length, 1);
  assert.equal(out[0].Date, '2026-01-01');
});

test('drivers with an empty InfFile are skipped', () => {
  const drivers = [
    { InfFile: '', Date: '2026-01-01', Provider: 'Acme' },
    driver('foo.inf', '2026-01-01'),
  ];
  assert.deepEqual(findOldDriverCandidates(drivers), []);
});

test('newest is determined by date, not input order', () => {
  const drivers = [
    driver('foo.inf', '2026-03-01'), // newest, listed first
    driver('foo.inf', '2026-01-01'), // old, listed second
  ];
  const out = findOldDriverCandidates(drivers);
  assert.equal(out.length, 1);
  assert.equal(out[0].Date, '2026-01-01');
});

test('drivers with missing Date are treated as oldest', () => {
  const drivers = [
    driver('foo.inf', '2026-01-01'),
    { InfFile: 'foo.inf', Provider: 'Acme' }, // no Date -> treated as epoch (oldest)
  ];
  const out = findOldDriverCandidates(drivers);
  assert.equal(out.length, 1);
  assert.equal(out[0].InfFile, 'foo.inf');
  // The no-Date driver is oldest, so it's the candidate
  assert.ok(!out[0].Date || out[0].Date === undefined);
});
