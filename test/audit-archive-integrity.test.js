import test from 'node:test';
import assert from 'node:assert/strict';
import { setSys } from '../src/backend/sys.js';
import * as archive from '../src/backend/archive.js';

const root = 'C:\\AuditArchive', file = `${root}\\archive.json`, known = `${root}\\known-programs.json`;
const legacy = { name: 'Legacy', removed: '2026-01-01T00:00:00.000Z', extra: { preserved: true } };
async function fixture(text = null, baseline = null) {
  const files = new Map([[file, text], [known, baseline]]), writes = [], control = {};
  setSys({ makeDir: async () => {}, readOptionalText: async (p) => {
    if (control.denied === p) throw Error('Read denied');
    return files.has(p) ? files.get(p) : null;
  }, writeTextAtomic: async (p, s) => {
    writes.push(p);
    if (control.fail === p) throw Error('Write denied');
    files.set(p, s);
  } });
  await archive.setRoot(root);
  return { files, writes, control };
}
const writers = {
  add: () => archive.add({ key: 'new', name: 'New' }, 'uninstalled'),
  attachBackup: () => archive.attachBackup(['old'], 'backup'),
  setPackage: () => archive.setPackage('old', 'Vendor.App'),
  remove: () => archive.remove('old'),
  outside: () => archive.outside([]),
};
for (const [name, run] of Object.entries(writers)) {
  test(`archive ${name} accepts absence and blocks read/JSON/schema failures without writes`, async () => {
    for (const bad of ['denied', undefined, '{bad', '{}', 'null', '[null]', JSON.stringify([{ ...legacy, backups: {} }]), JSON.stringify([{ ...legacy, key: 4 }])]) {
      const f = await fixture(bad);
      f.files.set(file, bad);
      if (bad === 'denied') f.control.denied = file;
      await assert.rejects(run(), /preserved.*restore/i);
      assert.deepEqual(f.writes, []);
      assert.equal(f.files.get(file), bad);
    }
    const f = await fixture();
    await run();
    assert.equal(f.writes.length, 1);
  });
}

test('all archive writers preserve legacy fields and backup references', async () => {
  const original = [{ ...legacy }, { ...legacy, id: 'old', key: 'OLD', backups: ['existing'], unknown: 42 }];
  const f = await fixture(JSON.stringify(original));
  await archive.attachBackup(['old'], 'new');
  await archive.setPackage('old', 'Vendor.App');
  await archive.add({ name: 'Another', key: 'another' }, 'forced');
  await archive.remove('not-found');
  await archive.outside([]);
  const saved = JSON.parse(f.files.get(file));
  assert.deepEqual(saved[0], original[0]);
  assert.deepEqual(saved[1], { ...original[1], backups: ['existing', 'new'], wingetId: 'Vendor.App' });
});

test('attaching a backup initializes only an absent legacy backups field', async () => {
  const f = await fixture(JSON.stringify([{ ...legacy, key: 'OLD' }]));
  await archive.attachBackup(['old'], 'backup');
  assert.deepEqual(JSON.parse(f.files.get(file))[0].backups, ['backup']);
});

test('invalid output types and serialization failures perform zero writes', async () => {
  for (const run of [() => archive.attachBackup(['old'], {}), () => archive.setPackage('old', {}),
    () => archive.remove(undefined), () => archive.setPackage(undefined, 'Vendor.App'),
    () => archive.add({ name: 'Bad', version: 0 }, 'forced'),
    () => archive.add({ name: 42 }, 'forced'), () => archive.add({ name: 'Bad', publisher: 1n }, 'forced'),
    () => archive.add({ name: 'Bad', key: 'bad' }, { toJSON: () => { throw Error('serialize'); } })]) {
    const f = await fixture(JSON.stringify([{ ...legacy, id: 'old', key: 'old', backups: ['keep'] }]));
    await assert.rejects(run());
    assert.deepEqual(f.writes, []);
  }
});

test('serialization is completed before the baseline or archive can be written', async () => {
  const f = await fixture(JSON.stringify([legacy]));
  const stringify = JSON.stringify;
  JSON.stringify = () => { throw Error('Serialization failed'); };
  try {
    await assert.rejects(archive.outside([]), /Serialization failed/);
    await assert.rejects(archive.add({ name: 'New' }, 'forced'), /Serialization failed/);
    assert.deepEqual(f.writes, []);
  } finally { JSON.stringify = stringify; }
});

test('concurrent archive additions do not lose entries', async () => {
  await fixture();
  await Promise.all(Array.from({ length: 8 }, (_, n) => archive.add({ name: `App ${n}` }, 'forced')));
  assert.equal((await archive.list()).length, 8);
});

test('outside validates both stores before writing, including known-programs record types', async () => {
  for (const bad of ['denied', undefined, '{bad', '[]', '{}', '{"saved":"bad","programs":{}}',
    JSON.stringify({ saved: legacy.removed, programs: { old: { key: 'old', name: 1 } } })]) {
    const f = await fixture(JSON.stringify([legacy]), bad);
    f.files.set(known, bad);
    if (bad === 'denied') f.control.denied = known;
    await assert.rejects(archive.outside([]), /preserved.*restore/i);
    assert.deepEqual(f.writes, []);
  }
});

test('outside commits archive before baseline and retries baseline failures without duplicate records', async () => {
  const baseline = JSON.stringify({ saved: legacy.removed, programs: { old: { key: 'old', name: 'Old' } }, unknown: 'keep' });
  for (const fail of [file, known]) {
    const f = await fixture(JSON.stringify([legacy]), baseline);
    f.control.fail = fail;
    await assert.rejects(archive.outside([]), /Write denied/);
    assert.equal(f.files.get(known), baseline);
    assert.deepEqual(f.writes, fail === file ? [file] : [file, known]);
    delete f.control.fail;
    await archive.outside([]);
    const saved = JSON.parse(f.files.get(file));
    assert.equal(saved.filter((e) => e.key === 'old').length, 1);
    assert.deepEqual(saved[0], legacy);
    assert.equal(JSON.parse(f.files.get(known)).unknown, 'keep');
  }
});
