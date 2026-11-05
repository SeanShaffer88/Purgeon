import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installerItems, stillPresent } from '../packages/purgeon-core/src/internal/installers.js';
import { scan } from '../packages/purgeon-core/src/internal/leftovers.js';
import { planRemoval, removeItems, setRoot } from '../packages/purgeon-core/src/internal/backups.js';
import { setSys } from '../packages/purgeon-core/src/internal/sys.js';

const product = '{11111111-2222-3333-4444-555555555555}';
const program = { name: 'MSI product fixture', key: product, uninstall: `MsiExec.exe /X${product}` };
const folder = 'C:\\Program Files\\SharedComponentsFixture';
const recorded = folder + '\\recorded.dll';
const sibling = folder + '\\unrelated.bin';
const noState = { programs: [], shared: [] };
const reason = 'Listed by its Windows Installer package';
const legacyFolder = { kind: 'dir', path: folder, reason, score: 100 };
const recordedFile = { kind: 'file', path: recorded, reason, score: 100 };

function host({ recordedIsDirectory = false, swapAtCheckpoint = false } = {}) {
  const entries = new Map([[folder, true], [recorded, recordedIsDirectory], [sibling, false]]);
  const state = new Map();
  const checkpoints = [];
  setSys({
    info: { home: 'C:\\Users\\MsiFixture', dataDir: 'C:\\MsiFixtureState', env: { ProgramFiles: 'C:\\Program Files', SystemRoot: 'C:\\Windows' } },
    exists: async (target) => entries.has(target),
    stat: async (target) => entries.has(target) ? { dir: entries.get(target), modified: 1 } : null,
    readDir: async () => [],
    walk: async () => [],
    taskInventory: async () => ({ rows: [], nextCursor: null }),
    acquireRecoveryLease: async () => 'fixture-lease',
    releaseRecoveryLease: async () => {},
    makeDir: async () => {},
    readOptionalText: async (target) => state.get(target) ?? null,
    readText: async (target) => state.get(target),
    removePath: async (target) => {
      assert.match(target, /^C:\\MsiFixtureState\\/i);
      state.delete(target);
    },
    writeTextAtomic: async (target, text) => {
      state.set(target, text);
      if (!target.endsWith('\\manifest.json')) return;
      const checkpoint = JSON.parse(text);
      checkpoints.push(checkpoint);
      if (swapAtCheckpoint && checkpoint.inFlight?.path === recorded) entries.set(recorded, true);
    },
    runPS: async (script, input) => {
      if (script.includes('WindowsInstaller.Installer')) {
        assert.equal(input, product);
        return JSON.stringify([recorded]);
      }
      if (script.includes('$i.kind -eq')) return JSON.stringify(JSON.parse(input).map((item) => entries.has(item.path)));
      return '[]';
    },
  });
  return { entries, checkpoints };
}

test('prepared MSI scan and cleanup plan select the recorded file without authorizing its sibling', async () => {
  const { entries } = host();
  const captured = await installerItems(program);
  const items = await scan({ ...program, installerItems: captured });
  const selected = items.filter((item) => item.confidence === 'high' && item.score >= 90);
  const plan = await planRemoval({ items: selected, state: noState });
  assert.deepEqual(plan.results.map(({ kind, path, ok }) => ({ kind, path, ok })), [
    { kind: 'file', path: recorded, ok: true },
  ]);
  await setRoot('C:\\MsiFixtureState\\backups');
  const trashed = [];
  const removed = await removeItems({
    title: 'MSI component fixture', items: selected, state: noState,
    trashItem: async (target) => { trashed.push(target); entries.delete(target); },
  });
  assert.deepEqual(trashed, [recorded]);
  assert.equal(removed.results[0].ok, true);
  assert.ok(removed.backupId);
  assert.ok(entries.has(folder));
  assert.ok(entries.has(sibling));
});

test('a fresh MSI scan retains independent registered install-location evidence', async () => {
  host();
  assert.deepEqual((await scan(program)).map(({ kind, path }) => [kind, path]), [['file', recorded]]);
  const items = await scan({ ...program, location: folder });
  assert.ok(items.some((item) => item.kind === 'dir' && item.path === folder && item.reason === 'Install location'));
});

test('legacy MSI parent directories are excluded from prepared scans and refused before removal intent', async () => {
  const { checkpoints } = host();
  const independentFolder = { ...legacyFolder, reason: 'Install location' };
  assert.deepEqual(await stillPresent([legacyFolder]), []);
  assert.deepEqual(await stillPresent([legacyFolder, independentFolder]), [independentFolder]);
  const items = [legacyFolder];
  const plan = await planRemoval({ items, state: noState });
  assert.equal(plan.results[0].ok, false);
  assert.match(plan.results[0].detail, /does not identify this folder/);
  await setRoot('C:\\MsiFixtureState\\backups');
  const removed = await removeItems({ title: 'Legacy MSI', items, state: noState, trashItem: () => assert.fail('legacy folder reached trash') });
  assert.deepEqual(removed.results, plan.results);
  assert.equal(removed.backupId, null);
  assert.ok(checkpoints.length);
  assert.ok(checkpoints.every((checkpoint) => checkpoint.intents.length === 0));
});

test('an MSI recorded path occupied by a directory is excluded or refused', async () => {
  const { checkpoints } = host({ recordedIsDirectory: true });
  assert.deepEqual(await scan(program), []);
  assert.deepEqual(await scan({ ...program, installerItems: [recordedFile] }), []);
  const items = [recordedFile];
  const plan = await planRemoval({ items, state: noState });
  assert.equal(plan.results[0].ok, false);
  assert.match(plan.results[0].detail, /could not be confirmed as a file/);
  await setRoot('C:\\MsiFixtureState\\backups');
  const removed = await removeItems({ title: 'Changed MSI path', items, state: noState, trashItem: () => assert.fail('replacement directory reached trash') });
  assert.deepEqual(removed.results, plan.results);
  assert.ok(checkpoints.every((checkpoint) => checkpoint.intents.length === 0));
});

test('a directory swapped in while the removal intent saves is not trashed or left in flight', async () => {
  const { checkpoints } = host({ swapAtCheckpoint: true });
  await setRoot('C:\\MsiFixtureState\\backups');
  const removed = await removeItems({
    title: 'MSI checkpoint swap', items: [recordedFile], state: noState,
    trashItem: () => assert.fail('replacement directory reached trash'),
  });
  assert.equal(removed.results[0].ok, false);
  assert.match(removed.results[0].detail, /could not be confirmed as a file/);
  assert.equal(removed.backupId, null);
  assert.ok(checkpoints.some((checkpoint) => checkpoint.inFlight?.path === recorded));
  assert.equal(checkpoints.at(-1).inFlight, undefined);
  assert.equal(checkpoints.at(-1).intents[0].status, 'not-present');
});
