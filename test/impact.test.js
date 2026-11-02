import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeImpact, failureHint } from '../src/backend/impact.js';

test('summarizeImpact counts by kind and formats the forecast size', () => {
  const s = summarizeImpact(
    [{ kind: 'file' }, { kind: 'dir' }, { kind: 'key' }, { kind: 'value' }, { kind: 'shortcut' }],
    1536 * 1024 * 1024
  );
  assert.equal(s.count, 5);
  assert.equal(s.needsRestart, false);
  assert.match(s.text, /^5 selected: 2 files or folders, 2 registry entries, 1 other item · about 1\.5 GB will be freed/);
});

test('summarizeImpact uses MB and KB sizes and singular wording', () => {
  assert.match(summarizeImpact([{ kind: 'file' }], 2.5 * 1024 * 1024).text, /1 selected: 1 file or folders · about 2\.5 MB/);
  assert.match(summarizeImpact([{ kind: 'key' }], 2048).text, /1 registry entry · about 2 KB/);
});

test('summarizeImpact flags services, tasks and drivers as restart items', () => {
  assert.equal(summarizeImpact([{ kind: 'service' }], 0).needsRestart, true);
  assert.equal(summarizeImpact([{ kind: 'task' }], 0).needsRestart, true);
  assert.equal(summarizeImpact([{ kind: 'driver' }], 0).needsRestart, true);
  assert.equal(summarizeImpact([{ kind: 'file' }], 0).needsRestart, false);
});

test('summarizeImpact of an empty selection says so', () => {
  assert.deepEqual(summarizeImpact([], 0), { count: 0, needsRestart: false, text: 'Nothing selected.' });
  assert.equal(summarizeImpact(null, 0).count, 0);
});

test('failureHint maps known failure wording to a plain next step', () => {
  assert.match(failureHint('The file is in use by another program'), /Close the program/);
  assert.match(failureHint('Access is denied'), /administrator/);
  assert.match(failureHint('The system cannot find the file specified'), /already gone/);
  assert.match(failureHint('Cancelled by user'), /Stopped by choice/);
});

test('failureHint says nothing for unknown wording', () => {
  assert.equal(failureHint('Something unexpected happened'), '');
  assert.equal(failureHint(''), '');
  assert.equal(failureHint(undefined), '');
});
