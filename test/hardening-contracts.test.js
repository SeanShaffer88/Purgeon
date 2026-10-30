// Regression contracts exercised by the authorized 2026-10-29 validation run.
// These exercise only in-memory contracts; they never mutate Windows or user files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { objectResult, pluginId } from '../src/backend/contracts.js';
import { validateTarget, validateRegistryText } from '../src/backend/import-policy.js';
import { canRememberConfirmation } from '../src/backend/confirmation-policy.js';
import { preferences } from '../src/backend/sync.js';

test('single-object system responses are unwrapped and validated', () => {
  assert.deepEqual(objectResult([{ processes: [], totals: {} }], ['processes', 'totals']), { processes: [], totals: {} });
  for (const value of [null, [], [{}, {}], 'bad']) assert.throws(() => objectResult(value, ['processes']));
});

test('plugin ids cannot escape their installation directory', () => {
  assert.equal(pluginId('vendor_rules-2'), 'vendor_rules-2');
  for (const id of ['../outside', '..', 'x/y', 'C:\\rules', '', null]) assert.throws(() => pluginId(id));
});

test('registry imports cannot conceal other targets or deletion directives', () => {
  const target = 'HKEY_CURRENT_USER\\Software\\AuditVendor';
  const valid = 'Windows Registry Editor Version 5.00\r\n\r\n[' + target + ']\r\n"name"="value"\r\n';
  assert.equal(validateRegistryText(valid, target), valid);
  assert.throws(() => validateRegistryText(valid + '\r\n[HKEY_LOCAL_MACHINE\\SYSTEM]\\r\\n', target));
  assert.throws(() => validateRegistryText('Windows Registry Editor Version 5.00\r\n[-' + target + ']\r\n', target));
  assert.throws(() => validateTarget('HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet', 'value'));
});

test('destructive confirmations cannot be remembered', () => {
  assert.equal(canRememberConfirmation('confirmForce'), false);
  assert.equal(canRememberConfirmation('uninstall'), false);
  assert.equal(canRememberConfirmation('hideProgram'), true);
});

test('portable preferences never include secrets or security approvals', () => {
  const result = preferences({ textScale: 1.5, encryptionKey: 'private', pluginApprovals: { anything: 'approved' }, disabledConfirmations: ['uninstall'], safeMode: false });
  assert.equal(result.textScale, 1.5);
  for (const name of ['encryptionKey', 'pluginApprovals', 'disabledConfirmations', 'safeMode']) assert.equal(Object.hasOwn(result, name), false);
});
