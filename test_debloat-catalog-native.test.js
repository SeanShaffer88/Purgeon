import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Mirror of the native Debloat catalog validator (src-tauri/src/debloat_native.rs):
// the catalog is embedded in the Rust core and validated strictly at runtime —
// a catalog entry the native side rejects takes the whole Debloat view down,
// so the same rules are checked here where catalog edits are gated.
const tweaks = JSON.parse(readFileSync(new URL('../src/backend/debloat-catalog.json', import.meta.url), 'utf8'));
const PREFIXES = ['hkcu\\software\\', 'hkcu\\control panel\\', 'hklm\\software\\', 'hklm\\system\\currentcontrolset\\control\\'];

test('debloat catalog passes the native validator rules', () => {
  assert.ok(Array.isArray(tweaks) && tweaks.length > 0 && tweaks.length <= 256, 'catalog size');
  const ids = new Set();
  for (const t of tweaks) {
    assert.ok(t.id && t.id.length <= 64 && /^[a-z0-9_-]+$/.test(t.id) && !ids.has(t.id), `tweak id ${t.id}`);
    ids.add(t.id);
    assert.ok(Array.isArray(t.values) && t.values.length >= 1 && t.values.length <= 16, `values of ${t.id}`);
    assert.ok(['immediate', 'explorer', 'reboot'].includes(t.effect), `effect of ${t.id}`);
    const seen = new Set();
    for (const r of t.values) {
      const lc = r.key.toLowerCase();
      assert.ok(PREFIXES.some((p) => lc.startsWith(p)), `${t.id}: key prefix must be an allowed root (any casing): ${r.key}`);
      assert.ok(r.key.length <= 1024 && r.name.length <= 256, `${t.id}: key/name length`);
      assert.ok(r.key.split('\\').every((p) => p !== '' && p !== '.' && p !== '..'), `${t.id}: key parts of ${r.key}`);
      assert.ok(!r.key.includes('\0') && !r.name.includes('\0'), `${t.id}: no NUL bytes`);
      const dedupe = `${lc}|${r.name.toLowerCase()}`;
      assert.ok(!seen.has(dedupe), `${t.id}: duplicate resource ${r.key} ${r.name}`);
      seen.add(dedupe);
      for (const slot of ['on', 'off']) {
        const v = r[slot];
        if (v === undefined || v === null) continue;
        if (r.type === 'REG_DWORD') assert.ok(Number.isInteger(v) && v >= 0 && v <= 0xffffffff, `${t.id}: DWORD ${slot}`);
        else if (r.type === 'REG_SZ' || r.type === 'REG_EXPAND_SZ') assert.ok(typeof v === 'string' && !v.includes('\0') && v.length <= 4096, `${t.id}: string ${slot}`);
        else assert.fail(`${t.id}: unsupported type ${r.type}`);
      }
      if (r.deleteKeyOnRevert) assert.ok(lc.startsWith(`${r.deleteKeyOnRevert.toLowerCase()}\\`), `${t.id}: deleteKeyOnRevert must be a parent of the key`);
    }
  }
});
