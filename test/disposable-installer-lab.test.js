import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { api } from '../src/backend/api.js';
import { setSys } from '../src/backend/sys.js';
import { installerLabAdapter } from '../src/backend/tauri-sys.js';

const id = '56feaeef729a';
const result = { id, installerName: 'example.msi', folder: 'C:\\Fixture\\Purgeon Lab', sha256: 'a'.repeat(64) };

test('lab uses only the native pickers and opens only the generated folder identity on request', async () => {
  const calls = [];
  setSys(installerLabAdapter(async (...args) => {
    calls.push(args);
    return args[0] === 'generate_installer_lab' ? { ...result, privateInput: 'private' } : undefined;
  }));
  assert.deepEqual(await api.invoke('installerLab:generate'), result);
  await assert.rejects(api.invoke('installerLab:openFolder', { id: '../fixture' }), /Invalid lab identity/);
  await api.invoke('installerLab:openFolder', { id });
  assert.deepEqual(calls, [['generate_installer_lab'], ['open_installer_lab_folder', { id }]]);
});

test('lab report code is bounded, tied to the current lab, and has a transcription checksum', async () => {
  const report = 'P1-56FEAEEF729A-7-0001-0002-0003-F067C5AE';
  const arg = code => ({ code, id });
  assert.deepEqual(await api.invoke('installerLab:readCode', arg(report)), {
    coverage: 7, added: 1, missing: 2, changed: 3,
  });
  for (const code of [report.slice(0, -1) + '1', report.replace('P1-', 'P2-'), 'A'.repeat(512), report + '\nmore']) {
    await assert.rejects(api.invoke('installerLab:readCode', arg(code)), /Invalid lab report code/);
  }
  await assert.rejects(api.invoke('installerLab:readCode', { code: report, id: 'a'.repeat(12) }), /different lab/);
});

test('guest scripts parse in Windows PowerShell and produce an inert partial inventory report', async () => {
  const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', String.raw`
    $ErrorActionPreference = 'Stop'
    $root = (Resolve-Path 'src-tauri/src/disposable_installer_lab').Path
    foreach ($name in 'Start.ps1', 'Finish.ps1', 'Inventory.ps1') {
      $tokens = $null; $errors = $null
      $ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $root $name), [ref]$tokens, [ref]$errors)
      if ($errors.Count) { throw ($errors | Out-String) }
      $commands = $ast.FindAll({param($node) $node -is [Management.Automation.Language.CommandAst]}, $true)
      foreach ($command in $commands) {
        if ($command.GetCommandName() -match '^(Start-Process|Invoke-Expression|Invoke-WebRequest|msiexec(\.exe)?|WindowsSandbox(\.exe)?)$') {
          throw 'Guest helper launches a process or network call.'
        }
      }
    }
    foreach ($name in 'Start.ps1', 'Finish.ps1') {
      try { & (Join-Path $root $name); throw 'Guest helper ran outside the guest path.' }
      catch { if ($_.Exception.Message -ne 'Run this helper from C:\PurgeonLab inside Windows Sandbox.') { throw } }
    }
    . (Join-Path $root 'Inventory.ps1')
    function Get-LabInventory { throw 'Fixture must not query registry' }
    $a = 'A' * 64
    $b = 'B' * 64
    $before = @{lm64=@{complete=$true;rows=@{same=$a;changed=$a;gone=$a}};lm32=@{complete=$false};cu=@{complete=$true;rows=@{}}} | ConvertTo-Json -Depth 6 | ConvertFrom-Json
    $after = @{lm64=@{complete=$true;rows=@{same=$a;changed=$b;added=$b}};lm32=@{complete=$true;rows=@{ignored=$b}};cu=@{complete=$false}}
    $code = New-LabReportCode '56feaeef729a' $before $after
    [Console]::WriteLine($code)
    $before.lm64.rows.same = '../private'
    try { [void](New-LabReportCode '56feaeef729a' $before $after); throw 'Malformed fixture was accepted.' }
    catch { if ($_.Exception.Message -ne 'Guest baseline is invalid.') { throw } }
    exit 0
`], { encoding: 'utf8', timeout: 15000, maxBuffer: 64 * 1024, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.error?.message || result.stdout || 'PowerShell fixture failed');
  assert.deepEqual(await api.invoke('installerLab:readCode', { id, code: result.stdout.trim() }), {
    coverage: 1, added: 1, missing: 1, changed: 1,
  });
});
