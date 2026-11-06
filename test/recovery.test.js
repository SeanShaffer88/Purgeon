// Recovery Packages reports observed evidence and restores selected entries.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCipheriv, createHash, pbkdf2Sync } from 'node:crypto';
import { __handlers } from '../src/backend/api.js';
import { setSys } from '../src/backend/sys.js';
import { createNodeSys } from './node-sys.js';
import * as backups from '../src/backend/backups.js';
import * as winpath from '../src/backend/winpath.js';

const commands = [];
const nodeSys = { ...createNodeSys(), exec: async (file, args) => { commands.push([file, args]); return { ok: true, stdout: '', stderr: '' }; }, runPS: async () => '{}' };
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

test('verifyPackage records legacy evidence without claiming a seal', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'purgeon-recovery-'));
  await backups.setRoot(root);
  await makePackage(root);
  const v = await backups.verifyPackage('test1');
  assert.equal(v.ok, true);
  assert.equal(v.readiness.status, 'unknown', 'a legacy manifest has no integrity seal');
  assert.deepEqual(v.readiness.entries.map(({ index, status }) => [index, status]), [[0, 'unknown'], [1, 'unknown']]);
  assert.equal(v.exportsChecked, 2, 'both registry exports were observed');
  assert.ok(fs.existsSync(at(root, 'test1', 'verified.json')), 'the verdict is recorded');
  assert.ok(!fs.existsSync(at(root, 'test1', '.trial')), 'there is no trial scratch folder');
  const recorded = JSON.parse(fs.readFileSync(at(root, 'test1', 'verified.json'), 'utf8'));
  assert.equal(recorded.ok, true, 'the recorded verdict is the one the package list shows as its badge');
  fs.rmSync(root, { recursive: true, force: true });
});

const hash = (data) => createHash('sha256').update(data).digest('hex');
const getManifest = (dir) => JSON.parse(fs.readFileSync(at(dir, 'manifest.json'), 'utf8'));
const saveManifest = (dir, manifest) => fs.writeFileSync(at(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
const seal = (manifest, files) => {
  const body = { ...manifest, files };
  delete body.fingerprint;
  return { ...body, fingerprint: hash(JSON.stringify(body)) };
};

async function inertPackage(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'purgeon-readiness-'));
  t.after(() => { setSys(nodeSys); fs.rmSync(root, { recursive: true, force: true }); });
  await backups.setRoot(root);
  return makePackage(root);
}

test('a sidecar is dated and bound to the exact manifest, ignoring legacy or forged badge data', async (t) => {
  const dir = await inertPackage(t);
  const manifest = seal(getManifest(dir), { '0.reg': hash(REG), '1.reg': hash(REG) });
  const sidecar = at(dir, 'verified.json');
  saveManifest(dir, { ...manifest, verified: true, readiness: { status: 'checked' } });
  fs.writeFileSync(sidecar, JSON.stringify({ ok: true, at: '2026-01-01T00:00:00.000Z' }));
  let [row] = await backups.list();
  assert.equal(row.verified, undefined);
  assert.equal(row.readiness, undefined);
  saveManifest(dir, manifest);
  const live = await __handlers['backups:verifyPackage']('test1');
  assert.equal(live.readiness.status, 'checked');
  assert.equal(live.recorded, true);
  assert.ok(Number.isFinite(Date.parse(live.at)));
  [row] = await backups.list();
  assert.deepEqual(row.readiness, live.readiness);
  assert.equal(row.verifiedAt, live.at);
  const bound = fs.readFileSync(sidecar, 'utf8');
  for (const status of ['blocked', 'unknown']) {
    const contradictory = JSON.parse(bound);
    contradictory.readiness.entries[0].status = status;
    fs.writeFileSync(sidecar, JSON.stringify(contradictory));
    [row] = await backups.list();
    assert.equal(row.readiness, undefined, 'contradictory checked summaries are ignored');
  }
  fs.writeFileSync(sidecar, bound);
  saveManifest(dir, { ...manifest, title: 'Changed package' });
  [row] = await backups.list();
  assert.equal(row.readiness, undefined);
});

test('unsafe or inconsistent hash tables and linked exports never reach stat, hashing or scratch I/O', async (t) => {
  const dir = await inertPackage(t);
  const manifest = getManifest(dir);
  const input = [];
  const forbidden = () => assert.fail('verification attempted scratch mutation');
  setSys({
    ...nodeSys,
    sha256Files: async (paths) => { input.push(...paths); return nodeSys.sha256Files(paths); },
    stat: async (target) => { input.push(target); return nodeSys.stat(target); },
    makeDir: forbidden, removePath: forbidden, writeText: forbidden,
  });
  for (const files of [
    { '../outside.reg': hash(REG), '1.reg': hash(REG) },
    { '0.reg': hash(REG), '1.reg': hash(REG), 'extra.reg': hash(REG) },
    { '0.reg': hash(REG), '0.REG': hash(REG) },
    { '0.reg': hash(REG), '1.reg': 'invalid' },
  ]) {
    saveManifest(dir, seal(manifest, files));
    assert.equal((await backups.verifyPackage('test1')).readiness.status, 'blocked');
    assert.deepEqual(input, []);
  }
  await assert.rejects(() => backups.verifyPackage('test1:stream'), /Invalid backup id/);
  saveManifest(dir, seal(manifest, { '0.reg': hash(REG), '1.reg': hash(REG) }));
  setSys({
    readDir: async (target) => (await nodeSys.readDir(target)).map((entry) => entry.name === '0.reg' ? { ...entry, link: true } : entry),
  });
  const observed = await backups.verifyPackage('test1');
  assert.deepEqual(observed.readiness.entries.map((entry) => entry.status), ['blocked', 'checked']);
  assert.deepEqual(input, [at(dir, '1.reg'), at(dir, '1.reg')]);
});

test('cancellation and sidecar write failure retain the previous dated record', async (t) => {
  const dir = await inertPackage(t);
  const sidecar = at(dir, 'verified.json');
  saveManifest(dir, seal(getManifest(dir), { '0.reg': hash(REG), '1.reg': hash(REG) }));
  const old = await backups.verifyPackage('test1');
  const previous = fs.readFileSync(sidecar, 'utf8');
  let cancel = false;
  setSys({ sha256Files: async (paths) => { cancel = true; return nodeSys.sha256Files(paths); } });
  const cancelled = await backups.verifyPackage('test1', () => cancel);
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.recorded, false);
  assert.equal(fs.readFileSync(sidecar, 'utf8'), previous);
  setSys({
    sha256Files: nodeSys.sha256Files,
    writeTextAtomic: async () => { throw new Error('fixture sidecar denial'); },
  });
  const current = await backups.verifyPackage('test1');
  assert.equal(current.recorded, false);
  assert.deepEqual(current.readiness, old.readiness);
  assert.equal(fs.readFileSync(sidecar, 'utf8'), previous);
});

test('readiness does not probe a sealed package that already completed rollback', async (t) => {
  const dir = await inertPackage(t);
  const body = {
    ...getManifest(dir), complete: true,
    recovery: { action: 'rollback', status: 'completed', started: '2026-10-29T00:00:00Z', completed: '2026-10-29T00:01:00Z' },
  };
  saveManifest(dir, seal(body, { '0.reg': hash(REG), '1.reg': hash(REG) }));
  setSys({ sha256Files: async () => assert.fail('completed recovery reached a file probe') });
  const result = await backups.verifyPackage('test1');
  assert.equal(result.readiness.status, 'blocked');
  assert.ok(result.readiness.entries.every((entry) => entry.status === 'blocked'));
});

test('restore readback observes only successfully restored selected local targets and preserves outcomes', async (t) => {
  const dir = await inertPackage(t);
  const manifest = getManifest(dir);
  const restored = 'C:\\RestoreFixture\\restored.txt';
  const occupied = 'C:\\RestoreFixture\\occupied.txt';
  const denied = 'C:\\RestoreFixture\\denied.txt';
  const missing = 'C:\\RestoreFixture\\missing.txt';
  const unselected = 'C:\\RestoreFixture\\unselected.txt';
  const observations = [];
  saveManifest(dir, { ...manifest, entries: [restored, occupied, denied, missing, unselected].map((target) => ({ kind: 'file', path: target, recycled: true })) });
  setSys({
    stat: async (target) => {
      observations.push(target);
      if (target === denied) throw new Error('denied');
      return { dir: false };
    },
    runPS: async (_script, input) => {
      const [target] = JSON.parse(input);
      return JSON.stringify({ [target]: target === occupied ? 'EXISTS' : target === missing ? 'NOTFOUND' : 'OK' });
    },
  });
  const old = await __handlers['backups:restoreEntries']({ id: 'test1', indexes: [0] });
  assert.equal(old[0].readback, undefined);
  assert.deepEqual(observations, []);
  const current = await __handlers['backups:restoreEntries']({ id: 'test1', indexes: [0, 1, 2, 3], includeReadback: true });
  assert.deepEqual(current.map((entry) => entry.ok), [true, true, true, false]);
  assert.deepEqual(current.map((entry) => entry.readback?.status), ['confirmed', 'unknown', 'unknown', undefined]);
  assert.deepEqual(observations, [restored, denied]);
  assert.match(current[1].readback.detail, /already occupied/);
  assert.match(current[0].readback.detail, /Contents were not checked/);
  const cancelled = await backups.restore('test1', [4], () => true, { includeReadback: true });
  assert.equal(cancelled[0].readback, undefined);
  assert.deepEqual(observations, [restored, denied]);
});

test('verification and listing read encrypted legacy packages without migrating settings', async (t) => {
  const dir = await inertPackage(t);
  const password = 'inert legacy key fixture';
  const salt = Buffer.alloc(16, 1);
  const iv = Buffer.alloc(12, 2);
  const cipher = createCipheriv('aes-256-gcm', pbkdf2Sync(password, salt, 100000, 32, 'sha256'), iv);
  const encoded = Buffer.concat([salt, iv, cipher.update(JSON.stringify(getManifest(dir))), cipher.final(), cipher.getAuthTag()]).toString('base64');
  fs.writeFileSync(at(dir, 'manifest.json'), 'PURGEON-ENC1:' + encoded);
  const writes = [];
  setSys({
    secretGet: async () => '',
    secretKeys: async () => [],
    secretSet: async () => assert.fail('verification migrated the plaintext setting'),
    readOptionalText: async (file) => file.endsWith('\\settings.json') ? JSON.stringify({ encryptionKey: password }) : null,
    writeTextAtomic: async (file, contents) => {
      writes.push(file);
      await nodeSys.writeTextAtomic(file, contents);
    },
  });
  const result = await backups.verifyPackage('test1');
  assert.equal(result.recorded, true);
  assert.equal(result.exportsChecked, 2);
  assert.equal((await backups.list())[0].readiness.status, 'unknown');
  assert.deepEqual(writes, [at(dir, 'verified.json')]);
});

test('native task and firewall readback require exact settled evidence', async (t) => {
  const dir = await inertPackage(t);
  const task = '\\Fixture\\Agent';
  const journal = 'a'.repeat(32);
  const planId = 'b'.repeat(32);
  let taskState = { path: task, enabled: false };
  let settled = true;
  let firewallFailure = false;
  saveManifest(dir, { ...getManifest(dir), entries: [
    { kind: 'task', path: task, nativeTaskJournalId: journal },
    { kind: 'firewall', path: 'AgentRule', file: '0.reg' },
    { kind: 'key', path: 'HKCU\\Software\\Fixture', file: '1.reg' },
  ] });
  setSys({
    taskRecovery: async (id) => {
      assert.equal(id, journal);
      return { completed: true, deleted: true, recoverable: true, path: task };
    },
    prepareTask: async (request) => {
      assert.deepEqual(request, { kind: 'recoverDeleted', journalId: journal });
      return { id: planId, summary: 'Fixture', requiresElevation: false };
    },
    executeTask: async () => ({ ok: true, journalId: planId, changed: true, settled, recoverable: false, task: taskState }),
    runPS: async (script) => {
      assert.match(script, /Get-SafeFirewallSnapshot/);
      if (firewallFailure) throw new Error('OK');
      return 'OK';
    },
  });
  const ready = await backups.verifyPackage('test1');
  assert.equal(ready.readiness.entries[0].status, 'checked');
  const restore = () => __handlers['backups:restore']({ id: 'test1', includeReadback: true });
  const initial = await restore();
  assert.deepEqual(initial.map((entry) => entry.readback.status), ['confirmed', 'confirmed', 'unknown']);
  taskState = { path: '\\Fixture\\Unrelated', enabled: false };
  firewallFailure = true;
  const mismatch = await restore();
  assert.deepEqual(mismatch.map((entry) => entry.readback.status), ['unknown', 'unknown', 'unknown']);
  taskState = { path: task, enabled: false };
  settled = false;
  assert.equal((await restore())[0].readback.status, 'unknown');
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
  const before = commands.length;
  const only = await backups.restore('test1', [1]);
  assert.equal(commands.length - before, 1, 'only one mocked import command was dispatched');
  assert.equal(commands[before][1][0], 'import');
  assert.equal(only.length, 1, 'exactly one entry was attempted');
  assert.equal(only[0].path, 'HKLM\\SOFTWARE\\Other');
  const all = await backups.restore('test1');
  assert.equal(all.length, 3, 'a plain restore still covers every entry');
  fs.rmSync(root, { recursive: true, force: true });
});
