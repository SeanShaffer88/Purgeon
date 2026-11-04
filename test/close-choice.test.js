import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setSys } from '../src/backend/sys.js';
import { createNodeSys } from './node-sys.js';

// The close question's "Remember my choice" writes closeAction through
// settings:set; the next launch reads it back through settings:get. Lock the
// round trip at the file level: a fresh module instance (a restarted app)
// must see the choice, from the bytes on disk — not from the in-process cache.
test('closeAction survives a settings write and a fresh-module read', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'purgeon-close-'));
  setSys(createNodeSys(dir));
  const settings = await import('../src/backend/settings.js');
  const next = await settings.writeSettings({ closeAction: 'tray', tray: true });
  assert.equal(next.closeAction, 'tray');
  const raw = JSON.parse(await fs.readFile(settings.settingsFile(), 'utf8'));
  assert.equal(raw.closeAction, 'tray', 'settings file on disk holds the choice');
  const fresh = await import('../packages/purgeon-core/src/internal/settings.js?restart=close');
  const again = await fresh.readSettings();
  assert.equal(again.closeAction, 'tray', 'a restarted app reads the remembered choice');
  assert.equal(again.tray, true);
});
