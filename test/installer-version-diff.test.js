import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareInstallRecordings, recordingIndex, summarizeRecording, RECORDING_ITEM_LIMIT, RECORDING_GROUP_LIMIT, RECORDING_TARGET_TEXT_LIMIT } from '../packages/purgeon-core/src/internal/installer-version-diff.js';

const recording = (id, items, extra = {}) => ({
  id, items, name: 'Inert recording ' + id, started: '2026-01-01T12:00:00.000Z', finished: '2026-01-01T12:01:00.000Z',
  installerInfo: { version: '1.2.3', product: 'Fixture', company: 'Local' }, ...extra,
});

test('compares only explicit targets from two distinct recorded sessions', () => {
  const a = recording('a', [{ kind: 'dir', path: 'C:\\Fixture' }, { kind: 'value', path: 'HKCU\\Software\\Fixture', name: '' }]);
  const b = recording('b', [{ kind: 'file', path: 'C:\\Fixture\\child.txt' }, { kind: 'value', path: 'HKEY_CURRENT_USER\\software\\fixture' }]);
  const result = compareInstallRecordings(a, b);
  assert.deepEqual(result.groups.map(({ kind, count }) => [kind, count]), [['a', 1], ['both', 1], ['b', 1]]);
  assert.equal(result.groups[1].rows[0].kind, 'value');
  assert.equal(result.a.stampedVersion, '1.2.3');
  assert.equal(compareInstallRecordings(a, { ...b, id: 'a' }), null);
});

test('registry aliases, default values and service case match without crossing kind or tuple boundaries', () => {
  const a = recording('a', [
    { kind: 'file', path: 'C:\\Fixture\\Literal.EXE' },
    { kind: 'dir', path: 'C:\\Fixture\\Kind' },
    { kind: 'key', path: 'HKLM\\Software\\Fixture' },
    { kind: 'key', path: 'HKCR' },
    { kind: 'key', path: 'HKU\\S-1-5-21\\Fixture' },
    { kind: 'key', path: 'HKCC\\Fixture' },
    { kind: 'value', path: 'HKCU\\Fixture', name: 'Mixed Case' },
    { kind: 'value', path: 'HKCU\\Fixture', name: '' },
    { kind: 'value', path: 'HKCU\\Fixture', name: '(default)' },
    { kind: 'value', path: 'HKCU\\Fixture|B', name: 'C' },
    { kind: 'setvalue', path: 'HKCU\\Fixture', name: 'Separate' },
    { kind: 'service', path: 'FixtureService' },
  ]);
  const b = recording('b', [
    { kind: 'file', path: 'C:\\Fixture\\literal.exe' },
    { kind: 'file', path: 'C:\\Fixture\\Kind' },
    { kind: 'key', path: 'HKEY_LOCAL_MACHINE\\software\\fixture' },
    { kind: 'key', path: 'hkey_classes_root' },
    { kind: 'key', path: 'HKEY_USERS\\s-1-5-21\\fixture' },
    { kind: 'key', path: 'HKEY_CURRENT_CONFIG\\fixture' },
    { kind: 'value', path: 'HKEY_CURRENT_USER\\fixture', name: 'mixed case' },
    { kind: 'value', path: 'HKCU\\Fixture' },
    { kind: 'value', path: 'HKCU\\Fixture', name: 'B|C' },
    { kind: 'value', path: 'HKCU\\Fixture', name: 'Separate' },
    { kind: 'service', path: 'fixtureservice' },
  ]);
  const { groups } = compareInstallRecordings(a, b);
  assert.deepEqual(groups.map(({ count }) => count), [5, 7, 4]);
  assert.equal(groups[1].rows.find(({ kind }) => kind === 'service').b.path, 'fixtureservice');
  assert.equal(groups[1].rows.find(({ kind, a }) => kind === 'value' && a.name === '').b.name, '');
  assert.ok(groups[0].rows.some(({ a }) => a.name === '(default)'));
  assert.ok(groups[0].rows.some(({ kind }) => kind === 'setvalue'));
  assert.ok(groups[2].rows.some(({ kind, b }) => kind === 'value' && b.name === 'Separate'));
});

test('evidence differences are named without disclosing data or choosing among duplicates', () => {
  const a = recording('a', [
    { kind: 'value', path: 'HKCU\\Fixture', name: 'Setting', data: 'sensitive registry A', reason: 'private command A', source: 'snapshot', confidence: 'low', score: 35 },
    { kind: 'key', path: 'HKLM\\Duplicate', evidence: 'private command duplicate' },
    { kind: 'key', path: 'HKEY_LOCAL_MACHINE\\duplicate', reason: 'another private command' },
  ], { installer: 'private command launcher', installerInfo: { version: '1.2.3', product: 'Product A', path: 'private command path' }, changedFiles: 7 });
  const b = recording('b', [
    { kind: 'value', path: 'HKCU\\fixture', name: 'setting', data: 'sensitive registry B', reason: 'private command B', source: 'trace', confidence: 'high', score: 100 },
    { kind: 'key', path: 'HKLM\\duplicate', confidence: 'high' },
  ], { installerInfo: { version: '1.2.3', product: 'Product B' }, changedFiles: 2 });
  const result = compareInstallRecordings(a, b);
  assert.equal(result.sameVersionStamp, true);
  assert.equal(result.differentProduct, true);
  assert.deepEqual(result.metadataDifferences, ['Recording label', 'Installer product stamp', 'Changed files count']);
  assert.equal(result.a.changedFiles, 7);
  assert.equal(result.b.changedFiles, 2);
  const [key, value] = result.groups[1].rows;
  assert.deepEqual([key.duplicates, key.a.count, key.b.count, key.differences], [true, 2, 1, []]);
  assert.deepEqual(value.differences, ['Source', 'Confidence', 'Score', 'Recorded reason']);
  assert.doesNotMatch(JSON.stringify(result), /private command|sensitive registry|uninstallKeys/);
});

test('ordering is stable and reversing recordings swaps only the appropriate sides', () => {
  const first = recording('a', [
    { kind: 'file', path: 'zeta' }, { kind: 'file', path: 'alpha' }, { kind: 'file', path: 'same' },
  ]);
  const second = recording('b', [{ kind: 'file', path: 'other' }, { kind: 'file', path: 'same' }]);
  const original = structuredClone([first, second]);
  Object.freeze(first.items);
  Object.freeze(second.items);
  const forward = compareInstallRecordings(first, second);
  const reverse = compareInstallRecordings(second, first);
  assert.deepEqual(forward.groups[0].rows.map(({ a }) => a.path), ['alpha', 'zeta']);
  assert.deepEqual(reverse.groups[2].rows.map(({ b }) => b.path), ['alpha', 'zeta']);
  assert.deepEqual(forward.groups.map(({ count }) => count), reverse.groups.map(({ count }) => count).reverse());
  assert.deepEqual([first, second], original);
});

test('legacy, empty and truncated recordings report evidence gaps separately', () => {
  const legacy = recording('a', undefined, { changedFiles: -1, installerInfo: {}, finished: 'invalid' });
  const malformed = recording('b', [
    null, { kind: 'unknown', path: 'fixture' }, { kind: 'value', path: 'HKCU\\Fixture', name: { data: 'private' } },
  ], { changedFiles: 0 });
  const none = compareInstallRecordings(legacy, malformed);
  assert.deepEqual([none.a.missing, none.a.total, none.a.changedFiles, none.a.finished, none.a.stampedVersion], [true, null, null, null, null]);
  assert.deepEqual([none.b.missing, none.b.total, none.b.changedFiles, none.b.unrecognized], [false, 3, 0, 3]);
  assert.ok(none.groups.every(({ count }) => count === 0));

  const many = Array.from({ length: RECORDING_ITEM_LIMIT + 1 }, (_, i) => ({ kind: 'file', path: 'target-' + i }));
  const cap = compareInstallRecordings(recording('a', many), recording('b', []));
  assert.equal(cap.a.examined, RECORDING_ITEM_LIMIT);
  assert.equal(cap.a.total, RECORDING_ITEM_LIMIT + 1);
  assert.equal(cap.groups[0].count, RECORDING_ITEM_LIMIT);
  assert.equal(cap.groups[0].rows.length, RECORDING_GROUP_LIMIT);
  assert.equal(cap.b.total, 0);
  assert.equal(cap.b.missing, false);
  const longPath = 'a'.repeat(30000);
  const textBound = compareInstallRecordings(recording('a', Array.from({ length: 100 }, (_, i) => ({ kind: 'file', path: longPath + i }))), recording('b', []));
  assert.equal(textBound.a.examined, Math.floor(RECORDING_TARGET_TEXT_LIMIT / (longPath.length + 2)));
  assert.equal(textBound.groups[0].rows[0].a.path.length, 1025);
  assert.equal(compareInstallRecordings(null, malformed), null);
});

test('long labels are clipped only for display and refreshed IDs stay distinct', () => {
  const prefix = 'long stamp '.repeat(25);
  const a = recording('a', [], { installerInfo: { product: prefix + 'a', version: prefix + 'a' } });
  const b = recording('b', [], { installerInfo: { product: prefix + 'b', version: prefix + 'b' } });
  const outcome = compareInstallRecordings(a, b);
  assert.equal(outcome.a.stampedVersion, outcome.b.stampedVersion);
  assert.equal(outcome.sameVersionStamp, false);
  assert.equal(outcome.differentProduct, true);
  assert.equal(summarizeRecording(a).stampedVersion.length, 161);
  const initial = recordingIndex([null, { id: '' }, a, b]);
  assert.equal(initial.get('a'), a);
  assert.equal(initial.get('b'), b);
  const refreshed = recordingIndex([a, { ...a }, { ...b, name: 'Fresh row' }]);
  assert.equal(refreshed.get('a'), null);
  assert.equal(refreshed.get('b').name, 'Fresh row');
});
