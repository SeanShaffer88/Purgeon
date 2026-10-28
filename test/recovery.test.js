// Recovery Packages: a backup is proven restorable (seal intact, stored
// exports still parse after a trial copy, verdict recorded beside the
// manifest), and restore can take single entries instead of everything.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setSys } from '../src/backend/sys.js';
import { createNodeSys } from './node-sys.js';
import * as backups from '../src/backend/backups.js';
import * as winpath from '../src/backend/winpath.js';

const nodeSys = createNodeSys();
setSys(nodeSys);

const REG = 'Windows Registry Editor Version 5.00\r\n\r\n[HKEY_LOCAL_MACHINE\\SOFTWARE\\Test]\r\n"A"=dword:00000001\r\n';

// backups.js speaks Windows paths (winpath), so the package is written at the
// winpath-joined locations the module itself uses — on this machine those are
// single backslash-named files, on Windows real folders; both round-trip.
const at = (root, ...parts) => winpath.join(root, ...parts);

// The recycled entry is opt-in: verifyPackage checks the Recycle Bin for
// real on Windows, and a fixture file is never actually in the Bin — the
// sound-package case would correctly report it missing. (On this machine the
// Bin check cannot run at all and is skipped as "unchecked".)
async function makePackage(root, id = 'test1', recycled = false) {
  const dir = at(root, id);
  await nodeSys.makeDir(dir);
  fs.writeFileSync(at(root, id, '0.reg'), REG);
  fs.writeFileSync(at(root, id, '1.reg'), REG);
  const manifest = {
    id,
    title: 'Test Program',
    created: '2026-10-28T00:00:00.000Z',
    entries: [
      { kind: 'key', path: 'HKLM\\SOFTWARE\\Test', file: '0.reg' },
      { kind: 'key', path: 'HKLM\\SOFTWARE\\Other', file: '1.reg' },
      ...(recycled ? [{ kind: 'file', path: 'C:\\Temp\\Gone.txt', recycled: true }] : []),
    ],
  };
  fs.writeFileSync(at(root, id, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return dir;
}

test('verifyPackage proves a sound package and records the verdict', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'purgeon-recovery-'));
  await backups.setRoot(root);
  await makePackage(root);
  const v = await backups.verifyPackage('test1');
  assert.equal(v.ok, true);
  assert.equal(v.exportsChecked, 2, 'both registry exports were trial-copied and parsed');
  assert.ok(fs.existsSync(at(root, 'test1', 'verified.json')), 'the verdict is recorded');
  assert.ok(!fs.existsSync(at(root, 'test1', '.trial')), 'the trial scratch folder is cleaned up');
  const recorded = JSON.parse(fs.readFileSync(at(root, 'test1', 'verified.json'), 'utf8'));
  assert.equal(recorded.ok, true, 'the recorded verdict is the one the package list shows as its badge');
  fs.rmSync(root, { recursive: true, force: true });
});

test('verifyPackage reports a damaged stored export instead of passing it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'purgeon-recovery-'));
  await backups.setRoot(root);
  await makePackage(root);
  fs.writeFileSync(at(root, 'test1', '1.reg'), '');
  const v = await backups.verifyPackage('test1');
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => /empty/i.test(p)), 'the damaged export is named as a problem');
  const recorded = JSON.parse(fs.readFileSync(at(root, 'test1', 'verified.json'), 'utf8'));
  assert.equal(recorded.ok, false, 'the recorded verdict is the failed one the list would badge');
  fs.rmSync(root, { recursive: true, force: true });
});

test('restore with entry indexes restores only the chosen entries', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'purgeon-recovery-'));
  await backups.setRoot(root);
  await makePackage(root, 'test1', true);
  const only = await backups.restore('test1', [1]);
  assert.equal(only.length, 1, 'exactly one entry was attempted');
  assert.equal(only[0].path, 'HKLM\\SOFTWARE\\Other');
  const all = await backups.restore('test1');
  assert.equal(all.length, 3, 'a plain restore still covers every entry');
  fs.rmSync(root, { recursive: true, force: true });
});
