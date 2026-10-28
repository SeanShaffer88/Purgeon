import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shapeStoreApp, noteFor } from '../src/backend/programs.js';

const base = { key: 'Microsoft.WindowsCalculator_11.0_x64__8wekyb3d8bbwe', pkgName: 'Microsoft.WindowsCalculator', family: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe', name: 'Calculator', version: '11.0', publisher: 'Microsoft', store: true };

test('ordinary apps are removable and get their note', () => {
  const a = shapeStoreApp({ ...base });
  assert.equal(a.locked, false);
  assert.equal(a.provisioned, false);
  assert.match(a.note, /Calculator/);
});

test('framework, resource, system and non-removable packages are locked', () => {
  for (const flag of ['framework', 'resource', 'system', 'nonRemovable']) {
    const a = shapeStoreApp({ ...base, [flag]: true });
    assert.equal(a.locked, true, flag);
    assert.ok(a.lockReason.length > 0, flag);
  }
});

test('provisioned copies are matched by package name, case-insensitively', () => {
  const a = shapeStoreApp({ ...base }, { 'microsoft.windowscalculator': 'Microsoft.WindowsCalculator_11.0_x64_neutral_8wekyb3d8bbwe' });
  assert.equal(a.provisioned, true);
  assert.match(a.provisionedName, /WindowsCalculator/);
  const b = shapeStoreApp({ ...base }, { 'microsoft.bingnews': 'x' });
  assert.equal(b.provisioned, false);
});

test('notes exist for the well-known pre-installed apps and stay empty otherwise', () => {
  assert.ok(noteFor('Microsoft.YourPhone').includes('Phone Link'));
  assert.ok(noteFor('Microsoft.WindowsStore').includes('Microsoft Store'));
  assert.equal(noteFor('Contoso.UnknownApp'), '');
  assert.equal(noteFor(''), '');
  assert.equal(noteFor(undefined), '');
});
