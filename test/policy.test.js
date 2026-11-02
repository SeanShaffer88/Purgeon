import test from 'node:test';
import assert from 'node:assert/strict';
import * as policy from '../src/backend/policy.js';

test('parsePolicy treats only explicit on-values as set', () => {
  assert.deepEqual(policy.parsePolicy({}), { batchUninstallDisabled: false, forceRemoveDisabled: false, secureEraseDisabled: false });
  assert.deepEqual(policy.parsePolicy({ DisableBatchUninstall: 1, DisableForceRemove: '1', DisableSecureErase: true }),
    { batchUninstallDisabled: true, forceRemoveDisabled: true, secureEraseDisabled: true });
  assert.deepEqual(policy.parsePolicy({ DisableBatchUninstall: 0, DisableForceRemove: '0', DisableSecureErase: 'yes' }),
    { batchUninstallDisabled: false, forceRemoveDisabled: false, secureEraseDisabled: false });
  assert.deepEqual(policy.parsePolicy(null), { batchUninstallDisabled: false, forceRemoveDisabled: false, secureEraseDisabled: false });
});

test('blockedBy names the policy for each blocked action and allows the rest', () => {
  const p = policy.parsePolicy({ DisableBatchUninstall: 1, DisableSecureErase: 1 });
  assert.match(policy.blockedBy(p, 'batch'), /DisableBatchUninstall/);
  assert.match(policy.blockedBy(p, 'erase'), /DisableSecureErase/);
  assert.equal(policy.blockedBy(p, 'force'), null);
  assert.equal(policy.blockedBy(policy.NO_POLICY, 'batch'), null);
  assert.equal(policy.blockedBy(null, 'erase'), null);
});

test('activeRestrictions lists one plain line per set policy', () => {
  assert.deepEqual(policy.activeRestrictions(policy.NO_POLICY), []);
  const lines = policy.activeRestrictions(policy.parsePolicy({ DisableForceRemove: 1 }));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Force removal is disabled/);
});
