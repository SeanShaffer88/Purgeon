import test from 'node:test';
import assert from 'node:assert/strict';
import { coreName, findDuplicates, findDuplicateEntries, findOldVersions } from '../src/backend/appdupes.js';

test('coreName strips versions, arch tags and edition words', () => {
  assert.equal(coreName('Foo Editor 12.3'), 'foo editor');
  assert.equal(coreName('Foo Editor (64-bit)'), 'foo editor');
  assert.equal(coreName('Foo Editor v2.0.1 x64'), 'foo editor');
  assert.equal(coreName('Bar Tool Community'), 'bar tool');
  assert.notEqual(coreName('Foo Editor'), coreName('Foo Player'));
});

const prog = (key, name, version, location) => ({ key, name, version, publisher: 'P', location });

test('findDuplicates groups two versions of one program', () => {
  const groups = findDuplicates([
    prog('k1', 'Foo Editor', '1.0', 'C:\\Foo'),
    prog('k2', 'Foo Editor 2.0', '2.0', 'C:\\Foo2'),
    prog('k3', 'Other App', '1.0', 'C:\\Other'),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].kind, 'versions');
  assert.equal(groups[0].entries.length, 2);
});

test('findDuplicates calls same-version two-place installs copies and skips short names', () => {
  const groups = findDuplicates([
    prog('k1', 'Foo Editor', '1.0', 'C:\\Foo'),
    prog('k2', 'Foo Editor', '1.0', 'D:\\Foo'),
    prog('k3', 'Go', '1.0', 'C:\\Go'),
    prog('k4', 'Go', '1.1', 'C:\\Go2'),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].kind, 'copies');
});

test('selfhealth summarize reports the worst status', async () => {
  const { summarize } = await import('../src/backend/selfhealth.js');
  assert.equal(summarize([{ status: 'pass' }, { status: 'pass' }]).status, 'pass');
  assert.equal(summarize([{ status: 'pass' }, { status: 'warn' }]).status, 'warn');
  assert.equal(summarize([{ status: 'warn' }, { status: 'fail' }]).status, 'fail');
});

test('findDuplicateEntries groups only exact name+version+location matches', () => {
  const groups = findDuplicateEntries([
    prog('k1', 'Foo Editor', '1.0', 'C:\\Foo'),
    prog('k2', 'foo editor', '1.0', 'c:\\foo'),
    prog('k3', 'Foo Editor', '2.0', 'C:\\Foo'),
    prog('k4', 'Foo Editor', '1.0', 'D:\\Foo'),
    prog('k5', 'Bar', '1.0', 'C:\\Bar'),
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].keys, ['k1', 'k2']);
});

test('findDuplicateEntries never accuses entries without a version or location', () => {
  assert.deepEqual(findDuplicateEntries([prog('k1', 'Foo', '', 'C:\\Foo'), prog('k2', 'Foo', '', 'C:\\Foo')]), []);
  assert.deepEqual(findDuplicateEntries([prog('k1', 'Foo', '1.0', ''), prog('k2', 'Foo', '1.0', '')]), []);
  assert.deepEqual(findDuplicateEntries([]), []);
});

test('findOldVersions flags only the superseded copies, naming the newest', () => {
  const old = findOldVersions([
    prog('k1', 'Foo Editor', '1.0', 'C:\\Foo'),
    prog('k2', 'Foo Editor 2.0', '2.0', 'C:\\Foo2'),
    prog('k3', 'Foo Editor', '2.0', 'D:\\Foo2'),
    prog('k4', 'Bar', '1.0', 'C:\\Bar'),
    prog('k5', 'Bar', '1.0', 'D:\\Bar'),
  ]);
  assert.deepEqual([...old.entries()], [['k1', '2.0']]);
});

test('findOldVersions compares versions numerically and skips blank versions', () => {
  const old = findOldVersions([
    prog('k1', 'Foo', '9.0', 'C:\\Foo'),
    prog('k2', 'Foo', '10.0', 'C:\\Foo10'),
    prog('k3', 'Foo', '', 'C:\\FooX'),
  ]);
  assert.deepEqual([...old.entries()], [['k1', '10.0']]);
});
