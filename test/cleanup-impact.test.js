import assert from 'node:assert/strict';
import { test } from 'node:test';
import { __handlers } from '../packages/purgeon-core/src/internal/api.js';
import { setSys } from '../packages/purgeon-core/src/internal/sys.js';

const plan = __handlers['backups:plan'];
const root = 'C:\\CleanupImpactFixture';
const target = root + '\\tools\\agent.exe';
const file = { kind: 'file', path: target, reason: 'Recorded file' };
const dir = { kind: 'dir', path: root };
const owner = 'HKLM\\Software\\Uninstall\\Selected';
const other = 'HKEY_LOCAL_MACHINE\\Software\\Uninstall\\Consumer';

function host({ ownership = { programs: [], shared: [] }, entries = [], tasks = [], integrationFailure = false, taskFailure = false } = {}) {
  const reads = { ownership: 0, integrations: 0, tasks: 0 };
  const forbidden = () => assert.fail('preview must not modify the system');
  setSys({
    info: { home: 'C:\\Users\\Fixture', env: { SystemRoot: 'C:\\Windows' } },
    exists: async (path) => !path.endsWith('\\missing.exe'),
    stat: async () => ({ modified: 1, dir: false }),
    readText: async () => '{}',
    writeTextAtomic: forbidden,
    removePath: forbidden,
    trash: forbidden,
    acquireRecoveryLease: forbidden,
    runPS: async (script) => {
      if (script.includes('SharedDLLs')) {
        reads.ownership++;
        if (ownership instanceof Error) throw ownership;
        return JSON.stringify(ownership);
      }
      if (script.includes('qprotection') && !script.includes('managedServices')) return 'OK';
      if (script.includes('Get-NetFirewallRule')) return '[true]';
      if (script.includes('GetValueKind')) return JSON.stringify([{ path: 'HKCU\\Software\\Fixture', name: 'Setting' }]);
      assert.match(script, /managedServices/);
      reads.integrations++;
      if (integrationFailure) throw new Error('integration inventory denied');
      return JSON.stringify(entries);
    },
    taskInventory: async () => {
      reads.tasks++;
      if (taskFailure) throw new Error('native task inventory denied');
      return { rows: tasks, nextCursor: null };
    },
  });
  return reads;
}

test('opt-in cleanup impact uses the same ownership snapshot and keeps the legacy plan shape', async () => {
  const reads = host({
    ownership: {
      programs: [
        { name: 'Selected', key: owner, location: root },
        { name: 'Consumer', key: other, location: root + '\\tools' },
        { name: 'Prefix only', key: other + '2', location: root + '-Other' },
      ],
      shared: [{ path: target.toUpperCase(), count: 3 }, { path: target + '.bak', count: 2 }],
    },
    entries: [
      { type: 'run', name: 'Agent start', source: 'hkcu-run', command: '"' + target + '" --private-argument' },
      { type: 'service', name: 'Prefix sibling', command: '"' + root + '-Other\\agent.exe"' },
    ],
  });
  const legacy = await plan({ items: [file, dir], owners: [owner] });
  assert.deepEqual(Object.keys(legacy), ['results']);
  assert.deepEqual(reads, { ownership: 1, integrations: 0, tasks: 0 });
  const enhanced = await plan({ items: [file, dir], owners: [owner], includeImpact: true });
  assert.deepEqual(enhanced.results, legacy.results);
  assert.deepEqual(reads, { ownership: 2, integrations: 1, tasks: 1 });
  assert.deepEqual(enhanced.impact.sources, { installed: 'observed', shared: 'observed', integration: 'observed' });
  assert.deepEqual(enhanced.impact.items[0].applications, ['Consumer']);
  assert.deepEqual(enhanced.impact.items[0].sharedFiles, [{ name: 'AGENT.EXE', users: 3 }]);
  assert.deepEqual(enhanced.impact.items[0].startup, ['Agent start']);
  assert.deepEqual(enhanced.impact.items[0].services, []);
  assert.deepEqual(enhanced.impact.items[1].sharedFiles.map((item) => item.users), [3, 2]);
  assert.doesNotMatch(JSON.stringify(enhanced.impact), /private-argument|Prefix only|Prefix sibling/);
});

test('impact distinguishes no matches, partial references, and unavailable ownership or integration data', async () => {
  host();
  let result = await plan({ items: [file], includeImpact: true });
  assert.equal(result.results[0].ok, true);
  assert.deepEqual(result.impact.items[0].applications, []);
  assert.equal(result.impact.sources.integration, 'observed');
  assert.match(result.impact.items[0].recovery, /Recycle Bin entry, if retained/);

  const task = { name: 'Matching task', path: '\\Fixture\\', taskId: '1'.repeat(32), enabled: false, command: target };
  host({ ownership: {}, integrationFailure: true, tasks: [task] });
  result = await plan({ items: [file], includeImpact: true });
  assert.equal(result.results[0].ok, false);
  assert.match(result.results[0].detail, /Could not check/);
  assert.deepEqual(result.impact.sources, { installed: 'unavailable', shared: 'unavailable', integration: 'partial' });
  assert.deepEqual(result.impact.items[0].tasks, ['Matching task']);
  assert.match(result.impact.items[0].recovery, /No recovery action expected/);

  const entries = [{ type: 'folder', name: 'Observed shortcut', source: 'user-folder', command: target }];
  host({ entries, taskFailure: true });
  result = await plan({ items: [file], includeImpact: true });
  assert.equal(result.impact.sources.integration, 'partial');
  assert.deepEqual(result.impact.items[0].startup, ['Observed shortcut']);

  host({ ownership: new Error('access denied'), integrationFailure: true, taskFailure: true });
  result = await plan({ items: [file], includeImpact: true });
  assert.deepEqual(result.impact.sources, { installed: 'unavailable', shared: 'unavailable', integration: 'unavailable' });
  assert.doesNotMatch(JSON.stringify(result.impact), /denied/);
});

test('recovery wording follows plan outcome and native task inventory is reused', async () => {
  const taskId = '2'.repeat(32);
  const tasks = [{ name: 'Agent', path: '\\Fixture\\', taskId, enabled: false, command: target }];
  const entries = [
    { type: 'service', name: 'Agent service', command: '"' + target + '" --private' },
    { type: 'run', name: 'Unresolvable', source: 'hkcu-run', command: 'agent --private' },
  ];
  const reads = host({ tasks, entries });
  const result = await plan({
    items: [
      file, { kind: 'file', path: root + '\\missing.exe' }, { kind: 'dir', path: 'C:\\Windows\\System32' },
      { kind: 'task', path: '\\Fixture\\Agent', taskId }, { kind: 'service', path: 'Agent service' },
      { kind: 'value', path: 'HKCU\\Software\\Fixture', name: 'Setting' }, { kind: 'firewall', path: 'Agent rule' },
    ],
    includeImpact: true,
  });
  assert.deepEqual(reads, { ownership: 1, integrations: 1, tasks: 1 });
  const at = (path) => result.impact.items[result.results.findIndex((row) => row.path === path)];
  assert.match(at('\\Fixture\\Agent').recovery, /task definition and permissions/);
  assert.match(at('Agent service').recovery, /Service registry export/);
  assert.match(at('HKCU\\Software\\Fixture').recovery, /registry value and type/);
  assert.match(at('Agent rule').recovery, /firewall rule/);
  assert.match(at('C:\\Windows\\System32').recovery, /No recovery action expected/);
  assert.match(at(root + '\\missing.exe').recovery, /No recovery action expected/);
  assert.equal(at('\\Fixture\\Agent').pathEvidence, false);
  assert.deepEqual(at(target).services, ['Agent service']);
  assert.deepEqual(at(target).tasks, ['Agent']);
  assert.deepEqual(at(target).startup, []);
});

test('non-path plans skip extra sources and returned evidence is bounded independently of plan results', async () => {
  const reads = host();
  let result = await plan({ items: [{ kind: 'value', path: 'HKCU\\Software\\Fixture', name: 'Setting' }], includeImpact: true });
  assert.deepEqual(reads, { ownership: 0, integrations: 0, tasks: 0 });
  assert.deepEqual(result.impact.sources, { installed: 'not-applicable', shared: 'not-applicable', integration: 'not-applicable' });
  assert.equal(result.impact.items[0].pathEvidence, false);

  const many = Array.from({ length: 10 }, (_, index) => ({ type: 'run', name: 'Long ' + index + 'a'.repeat(300), source: 'hkcu-run', command: target }));
  host({ entries: many });
  result = await plan({ items: Array.from({ length: 205 }, () => file), includeImpact: true });
  assert.equal(result.results.length, 205);
  assert.equal(result.impact.items.length, 200);
  assert.equal(result.impact.truncated, true);
  assert.equal(result.impact.items[0].truncated, true);
  assert.equal(result.impact.items[0].startup.length, 6);
  assert.ok(result.impact.items[0].startup.every((name) => name.length === 180));
});
