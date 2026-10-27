// Tests for the CLI --uninstall command (#18).
// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { setSys } from '../src/backend/sys.js';
import { createNodeSys } from './node-sys.js';
import { runCli } from '../src/cli.js';

const nodeSys = createNodeSys();
setSys(nodeSys);

// Captures printed output and the exit code.
async function run(args, extraSys = {}) {
  const out = [];
  let code = null;
  setSys({ ...nodeSys, ...extraSys, print: async (t) => out.push(t), quit: async (c) => (code = c) });
  try {
    await runCli(args);
  } finally {
    setSys(nodeSys);
  }
  return { out: out.join(''), code };
}

test('--uninstall appears in help output', async () => {
  const { out } = await run(['--help']);
  assert.match(out, /--uninstall/);
});

test('--uninstall without a name is an error', async () => {
  const { out, code } = await run(['--uninstall']);
  assert.match(out, /Name the program/);
  assert.equal(code, 1);
});

test('--uninstall with a flag as the name is an error', async () => {
  const { out, code } = await run(['--uninstall', '--bogus']);
  assert.match(out, /Name the program/);
  assert.equal(code, 1);
});

test('--uninstall with an unknown program reports not found', async () => {
  // Mock sys.runPS to return an empty JSON array so listDesktop returns [].
  // On Linux PowerShell isn't available, so this mock lets us reach the
  // "not found" error path without calling runUninstaller.
  const { out, code } = await run(
    ['--uninstall', 'Nonexistent Program Xyz'],
    { runPS: async () => '[]' }
  );
  assert.match(out, /No program named "Nonexistent Program Xyz"/);
  assert.equal(code, 1);
});
