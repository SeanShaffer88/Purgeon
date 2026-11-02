// Regression tests for the 2026-10-28 bug audit: four defects that failed
// silently in the running app. Each test fails on the pre-fix code.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setSys } from '../src/backend/sys.js';
import { createNodeSys } from './node-sys.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'purgeon-regress-'));
setSys(createNodeSys(dataDir));

test('startup:trust answers instead of throwing (was: insights is not defined)', async () => {
  const { api } = await import('../src/backend/api.js');
  assert.deepEqual(await api.invoke('startup:trust', []), {});
  // An entry running from a Temp folder is flagged without any signature data.
  const out = await api.invoke('startup:trust', [{ id: 'e1', name: 'Evil', command: 'C:\\Users\\x\\AppData\\Local\\Temp\\evil.exe' }]);
  assert.ok(Array.isArray(out.e1) && out.e1.some((r) => /Temp/.test(r)), `expected a Temp-folder reason, got ${JSON.stringify(out)}`);
});

test('backgroundScan returns its results and records a history entry (was: history.add is not a function)', async () => {
  const schedule = await import('../src/backend/schedule.js');
  const history = await import('../src/backend/history.js');
  await schedule.setRoot(path.join(dataDir, 'schedule'));
  await history.setRoot(path.join(dataDir, 'history'));
  const r = await schedule.backgroundScan({ scope: 'leftovers' });
  assert.equal(typeof r.scanned, 'number');
  assert.equal(r.scope, 'leftovers');
  const entries = await history.list();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].type, 'Background scan');
});

test('a backup id of "." is refused instead of resolving to the whole backup root', async () => {
  const backups = await import('../src/backend/backups.js');
  await backups.setRoot(path.join(dataDir, 'backups'));
  await assert.rejects(async () => backups.remove('.'), /Invalid backup id/);
  await assert.rejects(async () => backups.remove('..'), /Invalid backup id/);
  // A syntactically valid id with no readable manifest is retained for review,
  // rather than reaching the trash layer without recovery evidence.
  await assert.rejects(async () => backups.remove('2026-10-28T00-00-00-000Z_test'), /journal and backup are retained/);
});

test('settings sync keeps its folder and on/off across a restart', async () => {
  const sync = await import('../src/backend/sync.js');
  const settings = await import('../src/backend/settings.js');
  const internal = path.join(dataDir, 'sync');
  const cloud = fs.mkdtempSync(path.join(os.tmpdir(), 'purgeon-sync-external-'));
  test.after(() => fs.rmSync(cloud, { recursive: true, force: true }));
  await sync.setRoot(internal);
  await sync.apply({ folder: cloud, on: true });
  const saved = await settings.readSettings();
  assert.equal(saved.syncOn, true);
  assert.equal(saved.syncFolder, cloud);
  // A fresh module instance is a restarted app: only the internal setRoot
  // (what backend init does) plus restore() may run before status is read.
  const fresh = await import('../src/backend/sync.js?restart=1');
  await fresh.setRoot(internal);
  await fresh.restore();
  const st = await fresh.status();
  assert.equal(st.enabled, true);
  assert.equal(st.folder, cloud);
});
