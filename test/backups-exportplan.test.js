import test from 'node:test';
import assert from 'node:assert/strict';
import { setSys } from '../src/backend/sys.js';
import { createNodeSys } from './node-sys.js';
import * as backups from '../src/backend/backups.js';

const nodeSys = createNodeSys();
setSys(nodeSys);

test('exportPlan writes HTML with correct counts', async () => {
  const plan = {
    results: [
      { kind: 'file', path: 'C:\\Foo\\a.txt', name: 'a.txt', detail: 'Would remove', ok: true },
      { kind: 'key', path: 'HKCU\\Software\\Foo', name: 'Foo', detail: 'Would skip', ok: false },
    ],
  };
  const result = await backups.exportPlan({ plan, format: 'html' });
  assert.ok(result.file);
  assert.equal(result.format, 'html');
  assert.equal(result.items, 2);
  const content = await nodeSys.readText(result.file);
  assert.ok(content.includes('Purgeon Removal Plan'));
  assert.ok(content.includes('2 items'));
  assert.ok(content.includes('1 would be removed'));
  assert.ok(content.includes('1 would be skipped'));
});

test('exportPlan writes CSV', async () => {
  const plan = { results: [{ kind: 'file', path: 'C:\\Foo', name: 'Foo', detail: 'd', ok: true }] };
  const result = await backups.exportPlan({ plan, format: 'csv' });
  assert.ok(result.file.endsWith('.csv'));
  const content = await nodeSys.readText(result.file);
  assert.ok(content.includes('Kind,Path,Name,Detail,Ok'));
  assert.ok(content.includes('file'));
  assert.ok(content.includes('C:\\Foo'));
});

test('exportPlan writes JSON', async () => {
  const plan = { results: [{ kind: 'file', path: 'C:\\Foo', name: 'Foo', detail: 'd', ok: true }] };
  const result = await backups.exportPlan({ plan, format: 'json' });
  assert.ok(result.file.endsWith('.json'));
  const content = await nodeSys.readText(result.file);
  const parsed = JSON.parse(content);
  assert.equal(parsed.results.length, 1);
  assert.equal(parsed.results[0].kind, 'file');
});

test('remove rejects invalid backup ids', () => {
  assert.throws(() => backups.remove(''), /Invalid/);
  assert.throws(() => backups.remove('../escape'), /Invalid/);
  assert.throws(() => backups.remove('a/b'), /Invalid/);
  assert.throws(() => backups.remove('con'), /Invalid/);
  assert.throws(() => backups.remove('nul.txt'), /Invalid/);
});
