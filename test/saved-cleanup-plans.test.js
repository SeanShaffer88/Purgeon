import assert from 'node:assert/strict';
import { test } from 'node:test';
import { __handlers } from '../src/backend/api.js';
import { setSys } from '../src/backend/sys.js';
import { readSavedCleanupPlan, reviewSavedCleanupPlan, serializeSavedCleanupPlan, SAVED_PLAN_MAX_BYTES } from '../packages/purgeon-core/src/internal/saved-cleanup-plans.js';

test('saving a cleanup preview asks for an explicit destination and writes only display fields', async () => {
  const output = [];
  setSys({
    saveDialog: async (options) => { output.push(options); return 'C:\\InertFixture\\cleanup-plan.json'; },
    writeTextAtomic: async (path, text) => { output.push([path, JSON.parse(text)]); },
  });
  await __handlers['backups:savePlan']({
    title: 'Inert review',
    owners: ['privilege fixture'],
    results: [{
      kind: 'task', path: '\\Fixture\\Task', program: 'Fixture', ok: true, detail: 'Dry run fixture',
      taskId: 'private token', score: 100, data: 'private data', recoveryToken: 'private grant',
    }],
  });
  assert.equal(output.length, 2);
  assert.equal(output[0].defaultPath, 'purgeon-cleanup-plan.json');
  assert.equal(output[1][0], 'C:\\InertFixture\\cleanup-plan.json');
  assert.deepEqual(output[1][1].rows, [
    { kind: 'task', path: '\\Fixture\\Task', name: '', group: 'Fixture', outcome: 'would-change', detail: 'Dry run fixture' },
  ]);
  assert.doesNotMatch(JSON.stringify(output), /privilege fixture|private token|private data|private grant|score/);
});

const path = 'C:\\CleanupFixture\\sample.exe';
const result = (kind = 'file', target = path, other = {}) => ({ kind, path: target, ok: true, detail: 'Would move to the Recycle Bin', ...other });
const parse = (value) => readSavedCleanupPlan(new File([value], 'plan.json'));
const saved = (results = [result()]) => JSON.parse(serializeSavedCleanupPlan({ title: 'Fixture', results }));

test('save cancellation and write failure do not open another path or report success', async () => {
  const writes = [];
  const request = { title: 'Fixture', results: [result()] };
  setSys({
    saveDialog: async () => null,
    writeTextAtomic: async (...args) => { writes.push(args); throw new Error('write rejected'); },
  });
  assert.equal(await __handlers['backups:savePlan'](request), false);
  assert.deepEqual(writes, []);
  setSys({ saveDialog: async () => 'C:\\InertFixture\\selected.json' });
  await assert.rejects(() => __handlers['backups:savePlan'](request), /write rejected/);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], 'C:\\InertFixture\\selected.json');
});

test('only the versioned strict display schema and bounded UTF-8 files are accepted', async () => {
  const value = saved();
  assert.deepEqual(await parse(JSON.stringify(value)), value);
  for (const variant of [
    { ...value, version: 2 },
    { ...value, createdAt: '2026-02-30T12:00:00.000Z' },
    { ...value, owners: ['forged owner'] },
    { ...value, rows: [{ ...value.rows[0], taskId: 'forged task ID' }] },
    { ...value, rows: [{ ...value.rows[0], ['__proto__']: 'forged' }] },
    { ...value, rows: [{ ...value.rows[0], kind: 'arbitrary-shell-command' }] },
    { ...value, rows: [{ ...value.rows[0], path: '  ' }] },
    { ...value, rows: [{ ...value.rows[0], detail: { secret: true } }] },
    { ...value, rows: Array.from({ length: 801 }, () => value.rows[0]) },
  ]) await assert.rejects(() => parse(JSON.stringify(variant)), /Invalid or unsupported/);
  await assert.rejects(() => parse('{"incomplete"'), /Invalid or unsupported/);
  await assert.rejects(() => parse(new Uint8Array([0xff, 0xfe, 0xfe])), /Invalid or unsupported/);
  await assert.rejects(() => parse(new Uint8Array(SAVED_PLAN_MAX_BYTES + 1)), /Invalid or unsupported/);
  await assert.rejects(() => readSavedCleanupPlan({ size: 9, slice: () => new Blob(['{}']) }), /Invalid or unsupported/);
  await assert.rejects(() => parse(''), /Invalid or unsupported/);
  assert.throws(() => serializeSavedCleanupPlan({ title: 'Fixture', results: Array.from({ length: 801 }, () => result()) }), /Invalid or unsupported/);
  assert.throws(() => serializeSavedCleanupPlan({ title: 'Fixture', results: Array.from({ length: 20 }, () => result('file', 'é'.repeat(30000))) }), /Invalid or unsupported/);
});

test('revalidation passes only unique exact live objects and leaves selection and saved ordering unchanged', async () => {
  const registry = 'HKCU\\Software\\CleanupFixture';
  const duplicate = 'C:\\CleanupFixture\\duplicate.exe';
  const freshMissing = 'C:\\CleanupFixture\\gone.exe';
  const blocked = 'C:\\CleanupFixture\\blocked.exe';
  const unsupported = 'C:\\CleanupFixture\\unavailable.exe';
  const historical = [
    result('file', path, { program: 'Program A' }),
    result('dir', path, { program: 'Program B' }),
    result('value', registry, { detail: 'Would record and delete the value' }),
    result('value', registry, { name: 'Named', detail: 'Would record and delete the value' }),
    result('file', duplicate),
    result('file', freshMissing),
    result('file', blocked),
    result('file', unsupported),
  ];
  const value = saved(historical);
  const file = Object.freeze({ ...historical[0], taskId: 'live token', confidence: 'high' });
  const defaultValue = Object.freeze({ ...historical[2], data: 'live data', score: 100, name: '' });
  const live = Object.freeze([file, defaultValue, ...historical.slice(4), { ...historical[4] }]);
  const rows = await reviewSavedCleanupPlan(value, live, {
    isAllowed: (item) => item.path !== blocked,
    check: async (items) => {
      assert.deepEqual(items.map((item) => item.path), [path, registry, freshMissing, unsupported]);
      assert.equal(items[0], file);
      assert.equal(items[1], defaultValue);
      return { results: [
        result('file', freshMissing, { detail: 'Already gone' }),
        { ...defaultValue, detail: 'Would record a changed value' },
        file,
        result('file', 'C:\\CleanupFixture\\unrelated.exe'),
      ] };
    },
  });
  assert.deepEqual(rows.map((row) => row.status), ['unchanged', 'missing', 'changed', 'missing', 'ambiguous', 'missing', 'blocked', 'unavailable']);
  assert.deepEqual(rows.map((row) => row.saved.group), ['Program A', 'Program B', '', '', '', '', '', '']);
  assert.deepEqual(rows.map((row) => row.saved), value.rows);
  assert.equal(value.rows[2].name, '', 'default registry value remains distinct from a named value');
  assert.doesNotMatch(JSON.stringify(rows), /live token|live data|score/);
});

test('fresh denials, conflicting results and failed providers cannot change saved or live authority', async () => {
  const file = result();
  const unavailable = await reviewSavedCleanupPlan(saved(), [file], {
    isAllowed: () => true,
    check: async () => { throw new Error('private provider detail'); },
  });
  assert.equal(unavailable[0].status, 'unavailable');
  assert.doesNotMatch(JSON.stringify(unavailable), /private provider detail/);
  const malformed = await reviewSavedCleanupPlan(saved(), [file], { isAllowed: () => true, check: async () => null });
  assert.equal(malformed[0].status, 'unavailable');
  const blocked = await reviewSavedCleanupPlan(saved(), [file], {
    isAllowed: () => true,
    check: async () => ({ results: [{ ...file, ok: false, detail: 'Current guard refused' }] }),
  });
  assert.equal(blocked[0].status, 'blocked');
  assert.equal(blocked[0].current.detail, 'Current guard refused');
  const unreadable = await reviewSavedCleanupPlan(saved(), [file], {
    isAllowed: () => true,
    check: async () => ({ results: [{ ...file, ok: false, detail: 'Could not check whether other programs use this, not deleted' }] }),
  });
  assert.equal(unreadable[0].status, 'unavailable');
  const ambiguous = await reviewSavedCleanupPlan(saved(), [file], {
    isAllowed: () => true, check: async () => ({ results: [file, { ...file }] }),
  });
  assert.equal(ambiguous[0].status, 'ambiguous');
  const duplicated = await reviewSavedCleanupPlan(saved([file, file]), [file], {
    isAllowed: () => true, check: () => assert.fail('duplicate saved rows reached the planner'),
  });
  assert.deepEqual(duplicated.map((row) => row.status), ['ambiguous', 'ambiguous']);
});
