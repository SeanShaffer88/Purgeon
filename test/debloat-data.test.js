import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { TWEAKS } from '../src/backend/debloat.js';

test('tweak ids are unique and well-formed', () => {
  const ids = TWEAKS.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate tweak id');
  for (const id of ids) assert.match(id, /^[a-z0-9]+$/, `bad id ${id}`);
});

test('every tweak is complete and engine-shaped', () => {
  for (const t of TWEAKS) {
    assert.ok(t.category && t.title && t.detail, `${t.id} misses text`);
    assert.ok(['immediate', 'explorer', 'reboot'].includes(t.effect), `${t.id} bad effect`);
    assert.ok(Array.isArray(t.values) && t.values.length >= 1, `${t.id} has no values`);
    for (const v of t.values) {
      assert.match(v.key, /^HK(CU|LM)\\/, `${t.id} bad key ${v.key}`);
      assert.ok(['REG_DWORD', 'REG_SZ'].includes(v.type), `${t.id} bad type ${v.type}`);
      assert.ok(v.on !== undefined && v.on !== null, `${t.id} misses its on value`);
      if (v.type === 'REG_DWORD') assert.equal(typeof v.on, 'number', `${t.id} DWORD on must be a number`);
      if (v.type === 'REG_SZ') assert.equal(typeof v.on, 'string', `${t.id} SZ on must be a string`);
    }
  }
});

test('app privacy consent toggles use the Deny/Allow string store', () => {
  const consentTweaks = TWEAKS.filter((t) => t.category === 'App Privacy' && t.values[0].type === 'REG_SZ');
  assert.ok(consentTweaks.length >= 25, `expected the consent set, got ${consentTweaks.length}`);
  for (const t of consentTweaks) {
    assert.equal(t.values[0].name, 'Value', t.id);
    assert.equal(t.values[0].on, 'Deny', t.id);
    assert.equal(t.values[0].off, 'Allow', t.id);
    assert.match(t.values[0].key, /CapabilityAccessManager\\ConsentStore\\/, t.id);
  }
});

test('every tweak category is named in the Debloat view order', () => {
  // Regression: batch 1 added App Privacy and Settings sync tweaks whose
  // categories were missing from the view's order list, and the view only
  // renders ordered categories — 38 working tweaks were invisible for a
  // release while the header still counted them.
  const view = fs.readFileSync(new URL('../src/debloat.jsx', import.meta.url), 'utf8');
  const order = /const CATEGORY_ORDER = \[([^\]]*)\]/.exec(view)[1];
  for (const t of TWEAKS) assert.ok(order.includes(`'${t.category}'`), `${t.id}: category "${t.category}" is not in the Debloat view's CATEGORY_ORDER`);
});

test('Edge tweaks are documented Microsoft policies under the Edge policy key', () => {
  const edge = TWEAKS.filter((t) => t.category === 'Microsoft Edge');
  assert.ok(edge.length >= 30, `expected the Edge batch, got ${edge.length}`);
  for (const t of edge) {
    for (const v of t.values) {
      assert.equal(v.key, 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge', `${t.id} writes outside the Edge policy key`);
      assert.equal(v.type, 'REG_DWORD', `${t.id} policy value is not a DWORD`);
      assert.equal(v.off, null, `${t.id} revert must remove the policy value, restoring Edge's default`);
    }
  }
  // Protection stays on: no tweak may switch off a safety feature.
  const names = edge.flatMap((t) => t.values.map((v) => v.name));
  assert.ok(!names.includes('SmartScreenEnabled') && !names.includes('TyposquattingCheckerEnabled'), 'Edge safety features are never offered as tweaks');
});
