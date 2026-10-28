import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCliArgs } from '../src/cli-args.js';
import { runCli } from '../src/cli.js';
import { setSys } from '../src/backend/sys.js';
import * as snapshots from '../src/backend/snapshots.js';
import { createNodeSys } from './node-sys.js';

const invalid = [
  ['unknown command', ['--maintenence'], /Unknown command/],
  ['bare argument', ['unexpected'], /Unknown command/],
  ['empty command', [''], /Unknown command/],
  ['prototype command', ['constructor'], /Unknown command/],
  ['conflicting commands', ['--maintenance', '--autostart', 'on'], /one command/],
  ['repeated command', ['--maintenance', '--maintenance'], /one command/],
  ['help mixed with operation', ['--autostart', 'on', '--help'], /one command/],
  ['help followed by operation', ['--help', '--maintenance'], /one command/],
  ['short help mixed with operation', ['--maintenance', '-h'], /one command/],
  ['Windows help mixed with operation', ['--maintenance', '/?'], /one command/],
  ['unknown option', ['--maintenance', '--dry-run'], /Unknown option/],
  ['option for another command', ['--maintenance', '--preset', 'quick'], /Unknown option/],
  ['extra positional value', ['--autostart', 'on', 'off'], /Unexpected argument/],
  ['missing snapshot name', ['--snapshot'], /Give the snapshot a name/],
  ['blank snapshot name', ['--snapshot', '  '], /Unexpected argument/],
  ['missing comparison target', ['--compare', 'Before'], /Name two snapshots/],
  ['missing report value', ['--compare', 'Before', 'now', '--report'], /Give --report a value/],
  ['blank report value', ['--compare', 'Before', 'now', '--report', ''], /Give --report a value/],
  ['missing preset value', ['--snapshot', 'Before', '--preset'], /Give --preset a value/],
  ['switch instead of value', ['--snapshot', 'Before', '--preset', '--maintenance'], /Give --preset a value/],
  ['unknown preset', ['--snapshot', 'Before', '--preset', 'huge'], /--preset must/],
  ['prototype preset', ['--snapshot', 'Before', '--preset', 'constructor'], /--preset must/],
  ['repeated option', ['--snapshot', 'Before', '--preset', 'quick', '--PRESET', 'deep'], /only once/],
  ['missing installer', ['--monitor'], /Name the installer/],
  ['missing monitor name', ['--monitor', 'C:\\setup.exe', '--name'], /Give --name a value/],
  ['missing autostart value', ['--autostart'], /Use --autostart/],
  ['invalid autostart value', ['--autostart', 'maybe'], /Use --autostart/],
  ['extra list argument', ['--list-snapshots', 'extra'], /Unexpected argument/],
  ['option before command', ['--preset', 'quick', '--snapshot', 'Before'], /Unknown command/],
  ['dash-prefixed value', ['--snapshot', '-Before'], /Unknown option/],
  ['NUL in argument', ['--snapshot', 'Before\0after'], /without NUL/],
  ['non-string argument', ['--snapshot', 1], /must be text/],
];

for (const [name, args, error] of invalid) {
  test(`rejects ${name} before initialization or system access`, async () => {
    const calls = [];
    let output = '';
    let exitCode;
    const forbidden = (name) => async () => { calls.push(name); throw new Error(`Unexpected system call: ${name}`); };
    setSys({
      info: { env: {}, dataDir: 'C:\\unused' },
      print: async (text) => { output += text; },
      quit: async (code) => { exitCode = code; },
      ...Object.fromEntries(['readDir', 'readText', 'writeText', 'exists', 'makeDir', 'exec', 'runPS', 'takeSnapshot', 'compareSnapshots', 'trackLaunch', 'runCommandLine'].map((name) => [name, forbidden(name)])),
    });
    await runCli(args, forbidden('initialize'));
    assert.equal(exitCode, 1);
    assert.match(output, /Error:/);
    assert.match(output, error);
    assert.deepEqual(calls, [], 'invalid requests must not reach the backend');
  });
}

test('parses every documented operation and preserves names and paths', () => {
  const cases = [
    [['--snapshot', 'Before X'], '--snapshot', ['Before X'], {}],
    [['--SNAPSHOT', 'Before X', '--PRESET', 'quick'], '--snapshot', ['Before X'], { '--preset': 'quick' }],
    [['--snapshot', 'Before', '--preset', 'standard'], '--snapshot', ['Before'], { '--preset': 'standard' }],
    [['--snapshot', 'Before', '--preset', 'deep'], '--snapshot', ['Before'], { '--preset': 'deep' }],
    [['--compare', 'Before', 'now', '--report', 'C:\\Reports\\my changes.json'], '--compare', ['Before', 'now'], { '--report': 'C:\\Reports\\my changes.json' }],
    [['--compare', 'Before', 'After'], '--compare', ['Before', 'After'], {}],
    [['--list-snapshots'], '--list-snapshots', [], {}],
    [['--monitor', 'C:\\Downloads\\My setup.exe', '--name', 'My Program'], '--monitor', ['C:\\Downloads\\My setup.exe'], { '--name': 'My Program' }],
    [['--maintenance'], '--maintenance', [], {}],
    [['--autostart', 'ON'], '--autostart', ['ON'], {}],
    [['--autostart', 'off'], '--autostart', ['off'], {}],
  ];
  for (const [args, command, values, options] of cases) {
    assert.deepEqual(parseCliArgs(args), { command, values, options });
  }
});

test('help aliases print help without initializing the backend', async () => {
  for (const args of [[], ['--help'], ['--HELP'], ['-h'], ['-H'], ['/?']]) {
    let output = '';
    let exitCode;
    setSys({ print: async (text) => { output = text; }, quit: async (code) => { exitCode = code; } });
    await runCli(args, async () => { assert.fail('help must not initialize the backend'); });
    assert.equal(exitCode, 0);
    assert.match(output, /Purgeon command line/);
    assert.match(output, /Use one command at a time/);
  }
});

test('valid requests initialize once before accessing their operation', async () => {
  const calls = [];
  let output = '';
  setSys({
    readDir: async () => { calls.push('list'); return []; },
    print: async (text) => { output = text; },
    quit: async (code) => { assert.equal(code, 0); },
  });
  await runCli(['--list-snapshots'], async () => { calls.push('initialize'); });
  assert.deepEqual(calls, ['initialize', 'list']);
  assert.match(output, /No snapshots yet/);
});

test('snapshot dispatch preserves its name and selected depth', async () => {
  const captures = [];
  const writes = [];
  let output = '';
  setSys({
    info: { env: {}, dataDir: 'C:\\unused' },
    makeDir: async () => {},
    takeSnapshot: async (...args) => { captures.push(args); return { dirs: 1, files: 2, keys: 3, values: 4, ms: 1000 }; },
    writeTextAtomic: async (...args) => { writes.push(args); },
    print: async (text) => { output = text; },
    quit: async (code) => { assert.equal(code, 0); },
  });
  await runCli(['--snapshot', 'Before My Program', '--preset', 'deep'], () => snapshots.setRoot('C:\\unused\\snapshots'));
  assert.equal(captures.length, 1);
  assert.equal(captures[0][1], 'Before My Program');
  assert.equal(captures[0][3], 10);
  assert.equal(writes.length, 1);
  assert.equal(JSON.parse(writes[0][1]).preset, 'deep');
  assert.match(output, /Before My Program/);
});

test('comparison dispatch uses both references and the requested JSON report path', async () => {
  const metas = {
    '1': { id: '1', name: 'Before', created: '2026-01-01', preset: 'quick' },
    '2': { id: '2', name: 'After', created: '2026-01-02', preset: 'quick' },
  };
  const comparisons = [];
  const writes = [];
  setSys({
    makeDir: async () => {},
    readDir: async () => ['1', '2'].map((id) => ({ file: true, name: `${id}.json` })),
    readText: async (path) => JSON.stringify(metas[path.match(/(\d+)\.json$/)[1]]),
    compareSnapshots: async (...args) => { comparisons.push(args); return { added: [], removed: [], changed: [], truncated: false }; },
    writeText: async (...args) => { writes.push(args); },
    print: async () => {},
    quit: async (code) => { assert.equal(code, 0); },
  });
  await runCli(['--compare', 'Before', 'After', '--report', 'C:\\Reports\\my changes.json'], () => snapshots.setRoot('C:\\unused\\snapshots'));
  assert.deepEqual(comparisons, [['C:\\unused\\snapshots\\1.snap', 'C:\\unused\\snapshots\\2.snap', 200000]]);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], 'C:\\Reports\\my changes.json');
  assert.equal(JSON.parse(writes[0][1]).afterId, '2');
});

test('initialization failure exits with an actionable error and does not dispatch', async () => {
  let output = '';
  setSys({
    readDir: async () => { assert.fail('must not dispatch after initialization fails'); },
    print: async (text) => { output = text; },
    quit: async (code) => { assert.equal(code, 1); },
  });
  await runCli(['--list-snapshots'], async () => { throw new Error('Storage unavailable'); });
  assert.match(output, /Error: Storage unavailable/);
});

test('adding an unknown option never turns a valid command into an accepted request', () => {
  const commands = [['--snapshot', 'Before'], ['--compare', 'Before', 'now'], ['--list-snapshots'], ['--monitor', 'C:\\setup.exe'], ['--maintenance'], ['--autostart', 'on'], ['--help']];
  // Deterministic adversarial corpus: each command, each insertion point, 32 distinct typos.
  for (const args of commands) {
    for (let at = 0; at <= args.length; at++) {
      for (let n = 0; n < 32; n++) {
        assert.throws(() => parseCliArgs([...args.slice(0, at), `--unknown-${n}`, ...args.slice(at)]));
      }
    }
  }
  for (const args of [null, {}, ' --help ', [undefined]]) assert.throws(() => parseCliArgs(args), /must be text/);
});

test('--help and the dispatched commands cannot drift apart', async () => {
  // Regression guard for the audit finding that --sync, --portableapps and
  // --export worked but were missing from --help: the help text and the real
  // command set are compared mechanically, in both directions.
  const fs = await import('node:fs');
  const cli = fs.readFileSync(new URL('../src/cli.js', import.meta.url), 'utf8');
  const cliArgs = fs.readFileSync(new URL('../src/cli-args.js', import.meta.url), 'utf8');
  const dispatched = new Set([...cli.matchAll(/cmd === '(--[a-z-]+)'/g)].map((m) => m[1]));
  for (const m of cliArgs.matchAll(/^ {2}'(--[a-z-]+)':/gm)) dispatched.add(m[1]);
  assert.ok(dispatched.size > 20, 'the dispatch set was actually found');
  const help = cli.slice(cli.indexOf('const HELP = `') + 'const HELP = `'.length, cli.indexOf('`;', cli.indexOf('const HELP = `')));
  const helpCommands = new Set([...help.matchAll(/^ {2}(--[a-z-]+)/gm)].map((m) => m[1]));
  assert.ok(helpCommands.size > 20, 'the help command list was actually found');
  for (const cmd of dispatched) assert.ok(helpCommands.has(cmd), `${cmd} is dispatched but missing from --help`);
  for (const cmd of helpCommands) assert.ok(dispatched.has(cmd), `${cmd} is in --help but nothing dispatches it`);
  // Every option flag the help mentions must be one the code really reads.
  const knownOptions = new Set([...cli.matchAll(/(?:option|flag)\(args, '(--[a-z-]+)'\)/g)].map((m) => m[1]));
  for (const m of cliArgs.matchAll(/'(--[a-z-]+)'/g)) knownOptions.add(m[1]);
  knownOptions.add('--json').add('--quiet');
  const helpTokens = new Set([...help.matchAll(/--[a-z-]+/g)].map((m) => m[0]));
  for (const token of helpTokens) {
    if (helpCommands.has(token)) continue;
    assert.ok(knownOptions.has(token), `${token} is mentioned in --help but no code reads it`);
  }
});

test('--history, --archive and --timeline dispatch and print their lists', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const winpath = await import('../src/backend/winpath.js');
  const history = await import('../src/backend/history.js');
  const archive = await import('../src/backend/archive.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'purgeon-cli-'));
  let output = '';
  setSys({
    ...createNodeSys(),
    info: { env: {}, dataDir: dir },
    print: async (text) => { output += text; },
    quit: async () => {},
    runPS: async () => '[]',
  });
  // Legacy commands dispatch straight to run(); in the real entry the backend
  // roots are set before dispatch, so the test sets them the same way.
  await history.setRoot(dir);
  await archive.setRoot(dir);
  const init = async () => {};
  fs.writeFileSync(winpath.join(dir, 'history.json'), JSON.stringify([{ id: 1, time: '2026-10-28T10:00:00.000Z', type: 'Removal', title: 'Removed "Old App"', detail: '' }]));
  fs.writeFileSync(winpath.join(dir, 'archive.json'), JSON.stringify([{ name: 'Old App', version: '1.0', how: 'uninstalled', removed: '2026-10-28T10:00:00.000Z', publisher: 'Example' }]));
  await runCli(['--history'], init);
  assert.match(output, /Removed "Old App"/);
  output = '';
  await runCli(['--archive'], init);
  assert.match(output, /Old App 1\.0/);
  output = '';
  await runCli(['--timeline'], init);
  assert.match(output, /Removed: Old App|Nothing recorded yet/);
  fs.rmSync(dir, { recursive: true, force: true });
});
