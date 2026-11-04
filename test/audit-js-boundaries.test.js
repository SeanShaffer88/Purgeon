import test from 'node:test';
import assert from 'node:assert/strict';
import { setSys } from '../src/backend/sys.js';
import * as power from '../src/backend/power.js';
import * as settings from '../src/backend/settings.js';
import * as log from '../src/backend/log.js';
import * as cookies from '../src/backend/cookierules.js';
import { execFileSync } from 'node:child_process';

test('power rejects either invalid timeout before issuing commands', async () => {
  const calls = [];
  setSys({ exec: async (...args) => { calls.push(args); return { ok: true }; } });
  for (const pair of [[1, -1], [null, 1], [1, null], [6001, 1], [1, 1.5]]) {
    await assert.rejects(power.setTimeout('screen', ...pair));
    assert.equal(calls.length, 0);
  }
});

test('settings isolate nested defaults, reads, queued inputs and write returns', async () => {
  let text = null, stamp = 1;
  setSys({ info: { dataDir: 'C:\\AuditSettings', env: {} },
    stat: async () => ({ modified: stamp }), readOptionalText: async () => text,
    writeTextAtomic: async (_file, value) => { text = value; stamp++; } });
  const first = await settings.readSettings();
  first.alertThresholds.cpu = 2;
  assert.equal((await settings.readSettings()).alertThresholds.cpu, 90);
  const patch = { alertThresholds: { cpu: 70 }, disabledConfirmations: ['one'] };
  const writing = settings.writeSettings(patch);
  patch.alertThresholds.cpu = 1;
  const result = await writing;
  assert.equal(result.alertThresholds.cpu, 70);
  result.alertThresholds.cpu = 3;
  const read = await settings.readSettings();
  assert.equal(read.alertThresholds.cpu, 70);
  read.disabledConfirmations.push('two');
  assert.deepEqual((await settings.readSettings()).disabledConfirmations, ['one']);
  assert.equal(JSON.parse(text).alertThresholds.cpu, 70);
});

test('command logs omit scripts, paths, arguments and exception payloads', async () => {
  let output = '';
  setSys({ makeDir: async () => {}, readDir: async () => [], appendText: async (_path, text) => { output += text; } });
  await log.setRoot('C:\\AuditLogs');
  const secret = 'SYNTHETIC_SECRET https://credential.example/ "quoted secret"';
  const error = new Error(secret);
  const target = { exec: async () => ({ ok: false, code: secret }), runPS: async () => { throw error; }, launch: async () => true };
  log.wrap(target);
  await target.exec(`C:\\${secret}\\tool.exe`, [secret]);
  await assert.rejects(target.runPS(secret), (caught) => caught === error);
  await target.launch(`C:\\${secret}\\tool.exe`, [secret]);
  await log.flushNow();
  assert.doesNotMatch(output, /SYNTHETIC_SECRET|credential\.example|quoted secret/);
  assert.match(output, /FAIL/);
  assert.match(output, /ms/);
});

test('cookie read faults propagate rather than becoming an empty rule list', async () => {
  setSys({ runPS: async () => { throw Error('Access denied'); } });
  await assert.rejects(cookies.rules(), /Access denied/);
});

test('cookie changes verify both browsers and expose partial failures', async () => {
  const roots = ['Registry::HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Google\\Chrome', 'Registry::HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Edge'];
  for (const failure of ['none', 'denied', 'partial', 'mismatch', 'remove']) {
    const rows = [];
    let writes = 0;
    setSys({ runPS: async (script) => {
      assert.match(script, /\$ErrorActionPreference = 'Stop'/);
      assert.doesNotMatch(script, /'HKLM\\/);
      if (failure === 'denied') throw Error('Access denied');
      if (script.includes('ConvertTo-Json')) return JSON.stringify(rows);
      writes++;
      if (failure === 'partial' && writes === 2) throw Error('Edge write denied');
      if (script.includes('New-ItemProperty') && failure !== 'mismatch') {
        rows.push({ root: roots[writes - 1], n: '1', pattern: 'example.com' });
      }
      if (script.includes('Remove-ItemProperty')) throw Error('Removal denied');
      return '';
    } });
    if (failure === 'none') {
      assert.deepEqual(await cookies.rules(), { blocked: [], allowed: [] });
      assert.equal((await cookies.addRule('blocked', 'example.com')).ok, true);
      assert.equal(rows.length, 2);
    } else if (failure === 'remove') {
      await assert.rejects(cookies.removeRule('blocked', 'example.com'), /may have different rules/);
    } else {
      await assert.rejects(cookies.addRule('blocked', 'example.com'), /denied|verification failed/i);
      if (failure === 'partial') assert.equal(rows.length, 1);
    }
  }
});

test('power preserves zero and reports second-command failure without a guessed rollback', async () => {
  const calls = [];
  setSys({ exec: async (_tool, args) => { calls.push(args); return { ok: calls.length === 1, stderr: 'DC denied' }; } });
  await assert.rejects(power.setTimeout('sleep', 0, 1), /DC denied/);
  assert.deepEqual(calls, [['/change', 'standby-timeout-ac', '0'], ['/change', 'standby-timeout-dc', '1']]);
});

test('cookie PowerShell distinguishes absent registry keys and terminating access failures with mocked cmdlets', async () => {
  for (const denied of [false, true]) {
    setSys({ runPS: async (script) => execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', `
function Join-Path { param($Path, $ChildPath) "$Path\\$ChildPath" }
function Test-Path { param($Path) $${denied} }
function Get-ItemProperty { param($Path) Write-Error 'Mock registry access denied' }
${script}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) });
    if (denied) await assert.rejects(cookies.rules(), /Mock registry access denied/);
    else assert.deepEqual(await cookies.rules(), { blocked: [], allowed: [] });
  }
});
