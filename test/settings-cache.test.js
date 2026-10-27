import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setSys } from '../src/backend/sys.js';
import { createNodeSys } from './node-sys.js';
import * as settings from '../src/backend/settings.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'purgeon-settings-'));
setSys(createNodeSys(dir));

// The module builds its path with the Windows path helpers (as on the real
// target), so external edits in this test go through the very same path.
const file = settings.settingsFile();

test('a missing settings file returns the defaults', async () => {
  const s = await settings.readSettings();
  assert.equal(s.createRestorePoints, settings.DEFAULT_SETTINGS.createRestorePoints);
  assert.equal(s.gridLines, true);
  assert.equal(s.safeMode, false);
});

test('write then read returns the written values, merged over the defaults', async () => {
  await settings.writeSettings({ safeMode: true, textScale: 1.5 });
  const s = await settings.readSettings();
  assert.equal(s.safeMode, true);
  assert.equal(s.textScale, 1.5);
  assert.equal(s.createRestorePoints, true);
});

test('an external rewrite with a newer mtime is picked up despite the cache', async () => {
  const warm = await settings.readSettings();
  assert.equal(warm.safeMode, true);
  fs.writeFileSync(file, JSON.stringify({ safeMode: false, silentUninstall: true }));
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(file, later, later);
  const s = await settings.readSettings();
  assert.equal(s.safeMode, false);
  assert.equal(s.silentUninstall, true);
  assert.equal(s.createRestorePoints, true);
});

test('replaceSettings replaces the file and reads back through the cache', async () => {
  await settings.replaceSettings({ ...settings.DEFAULT_SETTINGS, safeMode: true, silentUninstall: false });
  const s = await settings.readSettings();
  assert.equal(s.safeMode, true);
  assert.equal(s.silentUninstall, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).safeMode, true);
});
