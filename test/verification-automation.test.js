import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { runWorkload, workload, scenarios } from '../scripts/benchmark-workload.mjs';

test('benchmark fixture fixes pairs, denial, unequal content and path aliases', () => {
  const a = workload(1000);
  assert.equal(a.workloadHash, workload(1000).workloadHash);
  assert.equal(a.entries.length, 1100);
  assert.equal(a.rows[0].hash, a.rows[1].hash);
  assert.notEqual(a.rows[0].hash, a.rows[4].hash);
  assert.equal(a.rows[2].denied, true);
  assert.equal(a.rows[3].hashDenied, true);
  assert.equal(a.rows[8].dir, true);
  assert.equal(a.rows[9].link, true);
  assert.throws(() => workload(0));
  assert.throws(() => workload(11));
});

test('all backend benchmark scenarios satisfy independent oracles and repeat deterministically', async () => {
  for (const scenario of scenarios) {
    const first = await runWorkload(1000, scenario);
    const second = await runWorkload(1000, scenario);
    assert.equal(first.correctness, 'passed', scenario);
    assert.equal(first.outputHash, second.outputHash, scenario);
    assert.equal(first.workloadHash, second.workloadHash, scenario);
    assert.ok(first.memory.peakRssBytes > 0);
  }
  await assert.rejects(runWorkload(1000, 'unknown'), /Unknown scenario/);
});

test('PowerShell capture decodes UTF-8 pipes, bounds output and cleans up on exceptions', { skip: process.platform !== 'win32' }, () => {
  const source = readFileSync(new URL('../scripts/test-packaged-cli.ps1', import.meta.url), 'utf8');
  assert.match(source, /\[PurgeonCliCapture\]::ConfigureEncoding\(\$psi\)/);
  assert.match(source, /if \(\$started\) \{ \[PurgeonCliCapture\]::StopOwnedProcess\(\$p\) \}/);
  const csharp = source.match(/Add-Type -TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@/)[1];
  // Compile only the capture helper. No packaged app or installer is executed.
  const command = `
$ErrorActionPreference = 'Stop'
foreach ($file in @('scripts/test-packaged-cli.ps1', 'scripts/test-windows-installers.ps1')) {
  $tokens = $null; $errors = $null
  [void][Management.Automation.Language.Parser]::ParseFile((Join-Path $PWD $file), [ref]$tokens, [ref]$errors)
  if ($errors.Count) { throw ($errors | Out-String) }
}
Add-Type -TypeDefinition @'
${csharp}
'@
$p = [Diagnostics.Process]::new()
$reader = [IO.StreamReader]::new([IO.MemoryStream]::new([Text.Encoding]::UTF8.GetBytes('hello')))
try { if ([PurgeonCliCapture]::ReadBounded($reader, $p).GetAwaiter().GetResult() -cne 'hello') { throw 'Capture mismatch' } } finally { $reader.Dispose() }
$reader = [IO.StreamReader]::new([IO.MemoryStream]::new([Text.Encoding]::UTF8.GetBytes(('x' * 1048577))))
$rejected = $false
try { [void][PurgeonCliCapture]::ReadBounded($reader, $p).GetAwaiter().GetResult() } catch { if ($_.Exception.ToString() -notmatch 'exceeds 1 MiB') { throw }; $rejected = $true } finally { $reader.Dispose(); $p.Dispose() }
if (!$rejected) { throw 'Oversized output accepted' }
# Emit literal UTF-8 bytes on both OS pipes, without depending on the child's
# console encoding or PowerShell's source-file decoding. This includes help's ›.
$psi = [Diagnostics.ProcessStartInfo]::new((Get-Process -Id $PID).Path)
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
[PurgeonCliCapture]::ConfigureEncoding($psi)
foreach ($arg in @('-NoProfile', '-Command', '$bytes = [byte[]]@(226,128,186,32,195,169,32,240,159,167,170); [Console]::OpenStandardOutput().Write($bytes); [Console]::OpenStandardError().Write($bytes)')) { $psi.ArgumentList.Add($arg) }
$child = [Diagnostics.Process]::new()
$child.StartInfo = $psi
try {
  [void]$child.Start()
  $stdout = [PurgeonCliCapture]::ReadBounded($child.StandardOutput, $child)
  $stderr = [PurgeonCliCapture]::ReadBounded($child.StandardError, $child)
  if (!$child.WaitForExit(10000)) { throw 'Unicode child timed out' }
  $readers = [Threading.Tasks.Task]::WhenAll([Threading.Tasks.Task[]]@($stdout, $stderr))
  if (!$readers.Wait(5000)) { throw 'Unicode pipes remained open' }
  $expected = [Text.Encoding]::UTF8.GetString([byte[]]@(226,128,186,32,195,169,32,240,159,167,170))
  if ($child.ExitCode -ne 0 -or $stdout.Result -cne $expected -or $stderr.Result -cne $expected) { throw 'UTF-8 process pipe capture mismatch' }
} finally { [PurgeonCliCapture]::StopOwnedProcess($child); $child.Dispose() }
# An owned child blocks on its input pipe. An exception must still terminate it;
# no clock-based sleeps or unrelated process discovery are needed.
$psi.ArgumentList.Clear()
$psi.RedirectStandardInput = $true
foreach ($arg in @('-NoProfile', '-Command', '[Console]::WriteLine("ready"); [void][Console]::ReadLine()')) { $psi.ArgumentList.Add($arg) }
$child = [Diagnostics.Process]::new()
$child.StartInfo = $psi
$cleanupExercised = $false
try {
  [void]$child.Start()
  $ready = $child.StandardOutput.ReadLineAsync()
  if (!$ready.Wait(10000) -or $ready.Result -cne 'ready') { throw 'Cleanup child not ready' }
  try { throw 'injected capture failure' }
  finally { [PurgeonCliCapture]::StopOwnedProcess($child); $cleanupExercised = $child.HasExited }
} catch { if ($_.Exception.Message -ne 'injected capture failure') { throw } }
finally { [PurgeonCliCapture]::StopOwnedProcess($child); $child.Dispose() }
if (!$cleanupExercised) { throw 'Exception cleanup left owned child running' }
`;
  const result = spawnSync('pwsh', ['-NoProfile', '-Command', command], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test('installer refuses a real non-runner without changing runner variables', { skip: process.platform !== 'win32' || process.env.GITHUB_ACTIONS === 'true' }, () => {
  const result = spawnSync('pwsh', ['-NoProfile', '-File', 'scripts/test-windows-installers.ps1', '-Directory', 'not-used', '-Manifest', 'not-used', '-PriorInstaller', 'not-used', '-PriorSha256', '0'.repeat(64), '-PriorVersion', '1.4.2'], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /restricted to disposable GitHub-hosted runners/);
});

test('inventory retries whole snapshots for teardown locks and missing files, but fails denial and deadline', { skip: process.platform !== 'win32' }, () => {
  const source = readFileSync(new URL('../scripts/test-packaged-cli.ps1', import.meta.url), 'utf8');
  const helper = source.slice(source.indexOf('function Get-QuiescentInventory {'), source.indexOf("if (-not ('PurgeonCliCapture'"));
  const command = `
$ErrorActionPreference = 'Stop'
${helper}
$root = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($root)
$file = Join-Path $root 'lockfile'
$stable = Join-Path $root 'stable'
[IO.File]::WriteAllText($file, 'temporary')
[IO.File]::WriteAllText($stable, 'unchanged')
$held = [IO.File]::Open($file, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
try {
  $evidence = [Collections.Generic.List[object]]::new()
  $snapshot = { @(Get-ChildItem -LiteralPath $root | ForEach-Object { (Get-FileHash -LiteralPath $_.FullName -ErrorAction Stop).Hash }) }
  # Release/delete on the first retry condition: no clock-dependent fixture.
  $hashes = @(Get-QuiescentInventory -Snapshot $snapshot -Evidence $evidence -Wait { param($ms) $held.Dispose(); [IO.File]::Delete($file) })
  if ($evidence.Count -ne 2 -or !$evidence[0].transient -or $evidence[0].delayMs -le 0 -or $hashes.Count -ne 1 -or $hashes[0] -cne (Get-FileHash $stable).Hash) { throw 'Lock retry did not re-enumerate exact hashes' }
  $evidence.Clear()
  [IO.File]::WriteAllText($file, 'racing')
  $hashes = @(Get-QuiescentInventory -Evidence $evidence -Snapshot {
    $files = @(Get-ChildItem -LiteralPath $root)
    if (!$evidence.Count) { [IO.File]::Delete($file) }
    @($files | ForEach-Object { (Get-FileHash -LiteralPath $_.FullName -ErrorAction Stop).Hash })
  } -Wait { param($ms) })
  if ($evidence.Count -ne 2 -or $hashes.Count -ne 1) { throw 'Missing-file race did not retry whole snapshot' }
  $evidence.Clear()
  $rejected = $false
  try { Get-QuiescentInventory -Evidence $evidence -Snapshot { throw [UnauthorizedAccessException]::new('permanent denial') } -Wait { throw 'Denial must never wait' } }
  catch { if ($_.Exception.Message -notmatch 'permanent denial') { throw }; $rejected = $true }
  if (!$rejected -or $evidence.Count -ne 1 -or $evidence[0].transient) { throw 'Permanent denial swallowed' }
  $evidence.Clear()
  $rejected = $false
  try { Get-QuiescentInventory -Evidence $evidence -DeadlineMilliseconds 1 -Snapshot { throw [IO.IOException]::new('persistent sharing violation', [int]0x80070020) } -Wait { param($ms) } }
  catch { if ($_.Exception.Message -notmatch 'persistent sharing violation') { throw }; $rejected = $true }
  if (!$rejected -or $evidence[-1].delayMs -ne 0 -or !$evidence[-1].transient) { throw 'Persistent sharing violation escaped deadline' }
} finally { $held.Dispose(); [IO.Directory]::Delete($root, $true) }
`;
  const result = spawnSync('pwsh', ['-NoProfile', '-Command', command], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
