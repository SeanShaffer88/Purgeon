import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setSys } from '../src/backend/sys.js';
import * as boot from '../src/backend/boot.js';
import * as history from '../src/backend/history.js';

const planId = 'a'.repeat(32), journalId = 'b'.repeat(32);
const state = { timeout: 30, safeboot: 'none', entries: [{ id: '{11111111-2222-3333-4444-555555555555}', name: 'Fixture Windows', isCurrent: true, isDefault: true }] };
async function fixture(options = {}) {
  const calls = []; let saved = '[]';
  setSys({
    info: { dataDir: 'C:\\MockBootHistory' }, makeDir: async () => {}, readOptionalText: async () => saved,
    writeTextAtomic: async (_path, contents) => { saved = contents; },
    runPS: async () => { throw new Error('Forbidden generic PowerShell'); },
    exec: async () => { throw new Error('Forbidden generic command'); },
    bootState: async () => { calls.push(['state']); if (options.stateError) throw new Error(options.stateError); return options.state || state; },
    prepareBoot: async (request) => { calls.push(['prepare', request]); if (options.prepareError) throw new Error(options.prepareError); return { id: options.badPlan ? '../bad' : planId, summary: 'Native exact Boot change', requiresElevation: true }; },
    executeBoot: async (id) => { calls.push(['execute', id]); if (options.executeError) throw new Error(options.executeError); return { ok: true, journalId: options.badResult ? journalId : id }; },
  });
  await history.setRoot('C:\\MockBootHistory');
  return calls;
}

test('Boot inventory uses structured native state, preserving unknown specialist and absent timeout', async () => {
  const calls = await fixture();
  assert.deepEqual(await boot.state(), state);
  assert.deepEqual(calls, [['state']]);
  await fixture({ state: { ...state, timeout: null, safeboot: 'other' } });
  assert.equal((await boot.state()).timeout, null);
  for (const invalid of [{}, { ...state, timeout: -1 }, { ...state, safeboot: 'invented' }, { ...state, entries: [{}] }]) {
    await fixture({ state: invalid }); await assert.rejects(boot.state(), /invalid native Boot response/);
  }
  await fixture({ stateError: 'BCD provider failed' }); await assert.rejects(boot.state(), /BCD provider failed/);
});

test('Boot forward requests discard renderer originals and history contains only protected journal references', async () => {
  const calls = await fixture();
  await boot.setSafeBoot('network', { attackerChosenId: 'arbitrary', previous: 'none' }, false);
  await boot.setTimeout(0, 987654);
  assert.deepEqual(calls.filter(([kind]) => kind === 'prepare').map(([, request]) => request), [{ kind: 'safeBoot', mode: 'network' }, { kind: 'timeout', seconds: 0 }]);
  const entries = await history.list();
  assert.equal(entries.length, 2);
  for (const entry of entries) assert.deepEqual(entry.undo, { channel: 'boot:undo', arg: { journalId: planId } });
});

test('Boot undo sends only a journal reference and never creates an undo-of-undo', async () => {
  const calls = await fixture();
  await boot.undo({ journalId, previous: 999, path: 'renderer supplied path' });
  assert.deepEqual(calls[0], ['prepare', { kind: 'undo', journalId }]);
  assert.equal((await history.list())[0].undo, null);
  await assert.rejects(boot.undo({ journalId: '../bad' }), /valid native recovery/);
});

test('legacy renderer-owned undo and invalid inputs fail before prepare or restore-point work', async () => {
  const calls = await fixture();
  await assert.rejects(boot.setSafeBoot('minimal', null, true), /legacy Boot undo/);
  await assert.rejects(boot.setTimeout(10, null), /legacy Boot undo/);
  await assert.rejects(boot.setSafeBoot('dsrepair', 'none', false), /Unknown start mode/);
  for (const n of [-1, 1000, 1.5, '10', NaN]) await assert.rejects(boot.setTimeout(n, 30), /between 0 and 999/);
  assert.deepEqual(calls, []);
});

test('native cancellation, unavailable provider, stale plans and malformed results create no success history or fallback', async () => {
  for (const options of [{ prepareError: 'USER_CANCELLED' }, { prepareError: 'UAC denied' }, { prepareError: 'BCD provider unavailable' }, { executeError: 'state changed after consent' }, { executeError: 'retained uncertain journal' }, { badPlan: true }, { badResult: true }]) {
    const calls = await fixture(options);
    await assert.rejects(boot.setTimeout(5, 30));
    assert.equal((await history.list()).length, 0);
    assert.ok(calls.filter(([kind]) => kind === 'execute').length <= 1);
  }
});

test('optional restore-point failure prevents preparing a Boot mutation', async () => {
  const calls = await fixture();
  await assert.rejects(boot.setSafeBoot('minimal', 'none', true), /restore point could not be created/);
  assert.deepEqual(calls, []);
});

test('native WMI primitives reject false/numeric results and malformed types without querying WMI', async () => {
  const source = await readFile(new URL('../src-tauri/src/boot_native.rs', import.meta.url), 'utf8');
  const script = source.match(/const BCD_SCRIPT: &str = r#"([\s\S]*?)"#;/)?.[1] || source.match(/const BCD_SCRIPT:&str=r#"([\s\S]*?)"#;/)?.[1];
  assert.ok(script);
  // Execute only pure provider-result functions. Scope/class construction and
  // every real provider invocation remain outside this extracted test program.
  const invoke = script.slice(script.indexOf('function Invoke-Bcd'), script.indexOf('function Bind-Bcd'));
  const elements = script.slice(script.indexOf('function Elements'), script.indexOf('function Read-Core'));
  const body = `$ErrorActionPreference='Stop'; ${invoke}\n${elements}
  $script:result=@{ReturnValue=$true;Elements=@()}
  $fake=[pscustomobject]@{}
  $fake|Add-Member ScriptMethod GetMethodParameters {param($method);@{}}
  $fake|Add-Member ScriptMethod InvokeMethod {param($method,$args,$options);$script:result}
  $errors=@();foreach($value in @($false,0,$null)){$script:result=@{ReturnValue=$value;Elements=@()};try{$null=Elements $fake;$errors+='UNEXPECTED'}catch{$errors+='refused'}}
  $script:result=@{ReturnValue=$true;Elements=@()};$empty=Elements $fake;$absent=(Integer $empty 0x25000080)
  $bad=@{};$bad[[uint32]0x25000080]=@{Properties=@{Integer=$true};Integer='unreadable'};try{$null=Integer $bad 0x25000080;$errors+='UNEXPECTED'}catch{$errors+='refused'}
  $bad=@{};$bad[[uint32]0x26000081]=@{Boolean='unknown'};try{$null=Boolean $bad 0x26000081;$errors+='UNEXPECTED'}catch{$errors+='refused'}
  [pscustomobject]@{errors=@($errors);absent=($null -eq $absent);count=$empty.Count}|ConvertTo-Json -Compress`;
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(body, 'utf16le').toString('base64')], { windowsHide: true, timeout: 30000 });
  assert.deepEqual(JSON.parse(stdout), { errors: ['refused', 'refused', 'refused', 'refused', 'refused'], absent: true, count: 0 });
  const parseBody = `$source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(script).toString('base64')}'));$tokens=$null;$errors=$null;$null=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors);if($errors.Count){$errors|ForEach-Object{[Console]::Error.WriteLine($_.Message)};exit 1};'parsed'`;
  const parsed = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(parseBody, 'utf16le').toString('base64')], { windowsHide: true, timeout: 30000 });
  assert.equal(parsed.stdout.trim(), 'parsed');
});
