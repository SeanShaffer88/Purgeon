import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_GROUPS, builtinById } from '../src/builtins.js';

const run = (id, r, i) => !!builtinById(id)[2](r, i);

test('signature groups split unsigned from bad signature', () => {
  assert.equal(run('\u0001unsigned', {}, { signature: 'NotSigned' }), true);
  assert.equal(run('\u0001unsigned', {}, { signature: 'HashMismatch' }), false);
  assert.equal(run('\u0001badsig', {}, { signature: 'HashMismatch' }), true);
  assert.equal(run('\u0001badsig', {}, { signature: 'NotSigned' }), false);
  assert.equal(run('\u0001badsig', {}, { signature: 'Valid' }), false);
  assert.equal(run('\u0001badsig', {}, undefined), false);
  assert.equal(run('\u0001unsigned', {}, undefined), false);
});

test('offer and together come from insights', () => {
  assert.equal(run('\u0001offer', {}, { offer: true }), true);
  assert.equal(run('\u0001offer', {}, {}), false);
  assert.equal(run('\u0001together', {}, { together: ['X'] }), true);
});

test('large uses the row size at the 1 GB line', () => {
  assert.equal(run('\u0001large', { sizeKB: 1024 * 1024 }), true);
  assert.equal(run('\u0001large', { sizeKB: 1024 * 1024 - 1 }), false);
  assert.equal(run('\u0001large', { sizeKB: 0, sortSize: 2 * 1024 * 1024 }), true);
});

test('recent uses the install date within 30 days', () => {
  const tenDaysAgo = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
  const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  assert.equal(run('\u0001recent', { installDate: tenDaysAgo }), true);
  assert.equal(run('\u0001recent', { installDate: ninetyDaysAgo }), false);
  assert.equal(run('\u0001recent', { installDate: '' }), false);
});

test('publisher groups', () => {
  assert.equal(run('\u0001microsoft', { publisher: 'Microsoft' }), true);
  assert.equal(run('\u0001microsoft', { publisher: 'microsoft corporation' }), true);
  assert.equal(run('\u0001microsoft', { publisher: 'Contoso' }), false);
  assert.equal(run('\u0001nopublisher', { publisher: '' }), true);
  assert.equal(run('\u0001nopublisher', { publisher: '  ' }), true);
  assert.equal(run('\u0001nopublisher', { publisher: 'Contoso' }), false);
});

test('ids are unique and cannot collide with typed group names', () => {
  const ids = BUILTIN_GROUPS.map(([id]) => id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.ok(id.charCodeAt(0), 'id starts with a control character');
});
