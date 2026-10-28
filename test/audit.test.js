import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setSys } from '../src/backend/sys.js';
import { createNodeSys } from './node-sys.js';
import * as backups from '../src/backend/backups.js';
import * as settings from '../src/backend/settings.js';
import * as groups from '../src/backend/groups.js';
import * as diskusage from '../src/backend/diskusage.js';
import * as winpath from '../src/backend/winpath.js';

const nodeSys = createNodeSys();
setSys(nodeSys);

test('a damaged interrupted-removal record is reported, not silently lost', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'purgeon-audit-'));
  await backups.setRoot(root);
  const pending = winpath.join(root, 'pending.json'); // the path the module itself uses
  // A crash in the middle of writing the record leaves invalid JSON behind.
  fs.writeFileSync(pending, '{ "id": "x", "title": "half-writ');
  const found = await backups.interrupted();
  assert.ok(found, 'the damaged record still surfaces');
  assert.equal(found.corrupt, true);
  const out = await backups.resolveInterrupted('keep');
  assert.equal(out.corrupt, true);
  assert.equal(fs.existsSync(pending), false, 'choosing to leave things as they are clears the damaged record');
  assert.equal(await backups.interrupted(), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('two settings writes at the same time keep both changes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'purgeon-audit-'));
  setSys({ ...nodeSys, info: { ...nodeSys.info, dataDir: dir } });
  const slowWrite = async (p, text) => {
    await new Promise((r) => setTimeout(r, 25));
    fs.writeFileSync(p, text);
  };
  setSys({ ...nodeSys, info: { ...nodeSys.info, dataDir: dir }, writeText: slowWrite });
  await Promise.all([settings.writeSettings({ textScale: 1.25 }), settings.writeSettings({ reducedMotion: true })]);
  const after = JSON.parse(fs.readFileSync(settings.settingsFile(), 'utf8'));
  assert.equal(after.textScale, 1.25);
  assert.equal(after.reducedMotion, true);
  setSys(nodeSys);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a group name cannot impersonate a built-in group', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'purgeon-audit-'));
  await groups.setRoot(dir);
  await groups.set(['prog1'], '\u0001recent');
  const all = await groups.get();
  assert.ok(!all.prog1?.startsWith('\u0001'), `stored name must not start with the built-in marker, got ${JSON.stringify(all.prog1)}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('drives with no readable space at all are not listed', async () => {
  setSys({
    ...nodeSys,
    runPS: async () =>
      JSON.stringify([
        { root: 'C:\\', used: 171798691840, free: 85899345920 },
        { root: 'E:\\', used: 0, free: 0 },
        { root: 'F:\\', used: 0, free: 32212254720 },
      ]),
  });
  const ds = await diskusage.drives();
  assert.deepEqual(ds.map((d) => d.root), ['C:\\', 'F:\\']);
  setSys(nodeSys);
});

test('the drives script asks PowerShell for JSON, not a table', async () => {
  // Field failure (v1.0.7 on a real PC): the script lacked ConvertTo-Json, so
  // PowerShell printed a table, the JSON parse failed, and the view reported
  // "No drives found". This fake behaves like real PowerShell: JSON only
  // when the script asks for it, a formatted table otherwise.
  const scripts = [];
  setSys({
    ...nodeSys,
    runPS: async (script) => {
      scripts.push(script);
      if (!script.includes('ConvertTo-Json')) return 'Root Used         Free\n---- ----         ----\nC:\\  171798691840 85899345920';
      return JSON.stringify([{ root: 'C:\\', used: 171798691840, free: 85899345920 }]);
    },
  });
  const ds = await diskusage.drives();
  assert.deepEqual(ds.map((d) => d.root), ['C:\\']);
  assert.ok(scripts[0].includes('ConvertTo-Json'), 'the first drives script must request JSON');
  setSys(nodeSys);
});
