import { test } from 'node:test';
import assert from 'node:assert/strict';
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
