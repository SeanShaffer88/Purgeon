import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { runWorkload, workload, scenarios } from '../scripts/benchmark-workload.mjs';

test('WebView child launches quote executable paths and abort before reading an undefined exit code', () => {
  const source = readFileSync(new URL('../src-tauri/windows/installer.nsi', import.meta.url), 'utf8');
  assert.ok(source.includes('!insertmacro PurgeonExecWait \'"$6" ${WEBVIEW2INSTALLERARGS} /install\' $1'));
  assert.ok(source.includes('!insertmacro PurgeonExecWait `"$R1" /install appguid=${WEBVIEW2APPGUID}&needsadmin=true` $1'));
  assert.match(source, /!macro PurgeonExecWait COMMAND RESULT\s+ClearErrors\s+ExecWait '\$\{COMMAND\}' \$\{RESULT\}\s+\$\{If\} \$\{Errors\}\s+!insertmacro PurgeonTraceResult "webview" "webview.launch.failed" "ExecWait" "null"\s+DetailPrint "\$\(webview2InstallError\)"\s+Abort "\$\(webview2AbortError\)"\s+\$\{EndIf\}\s+!insertmacro PurgeonTraceResult "webview" "webview.launch.returned" "ExecWait" "\$\{RESULT\}"\s+!macroend/);
  assert.equal((source.match(/\$\{If\} \$1 = 0/g) || []).length, 2);
});

test('installer versions validate upgrade ordering and preserve exact prerelease identity', () => {
  const command = `
. ./scripts/windows-package-tools.ps1
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PWD 'scripts/test-windows-installers.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
foreach ($name in @('Get-InstallerBaseVersion', 'Assert-InstallerVersion')) {
  $function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
  if (!$function) { throw "Missing helper: $name" }
  Invoke-Expression $function.Extent.Text
}
foreach ($version in @('1.4.3', '1.5.0-alpha.1', '1.5.0-beta.2', '1.5.0-rc.0')) {
  if ((Get-InstallerBaseVersion $version) -le [version]'1.4.2') { throw 'Newer candidate rejected' }
  Assert-InstallerVersion $version $version
}
foreach ($version in @('1.4.2', '1.4.2-alpha.1', '1.4.1')) {
  if ((Get-InstallerBaseVersion $version) -gt [version]'1.4.2') { throw 'Non-upgrade accepted' }
}
foreach ($version in @('1.5', '1.5.0-alpha.01', '1.5.0+build', '1.5.0-alpha.1+build', '1.5.0.0', 'garbage')) {
  $rejected = $false
  try { Get-InstallerBaseVersion $version } catch { $rejected = $true }
  if (!$rejected) { throw "Invalid version accepted: $version" }
}
foreach ($actual in @('1.5.0', '1.5.0-alpha.2', '1.5.0-beta.1', '1.4.3', '1.5.0-alpha.1+build', '1.5.0-ALPHA.1', '1.5.0.0')) {
  $rejected = $false
  try { Assert-InstallerVersion $actual '1.5.0-alpha.1' } catch { $rejected = $true }
  if (!$rejected) { throw "Wrong identity accepted: $actual" }
}
`;
  const result = spawnSync('pwsh', ['-NoProfile', '-Command', command], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const source = readFileSync(new URL('../scripts/test-windows-installers.ps1', import.meta.url), 'utf8');
  assert.match(source, /Assert-InstallerVersion \$actual \$Version/);
  assert.match(source, /Assert-InstallerVersion \$reg.DisplayVersion \$Version/);
  assert.match(source, /if \(\$Hash -and \$actualHash -ne \$Hash\)/);
});

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


test('installed identity persists actual and expected hashes before rejecting mismatch', () => {
  const command = `
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PWD 'scripts/test-windows-installers.ps1'), [ref]$tokens, [ref]$errors)
$function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Assert-Installed' }, $true)
Invoke-Expression $function.Extent.Text
# Inert bytes and identity adapters only; never execute an installer or touch registry.
function Assert-PeMachine { }
function Assert-InstallerVersion { }
function Test-Path { $true }
function Get-ItemProperty { @{ DisplayVersion = '1.5.0-alpha.1'; InstallLocation = $install } }
$exe = [IO.Path]::GetTempFileName()
$out = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($out)
try {
  [IO.File]::WriteAllText($exe, 'inert installed bytes')
  $install = 'owned-test-install'
  $registries = @('inert-registry-adapter')
  $stages = [Collections.Generic.List[object]]::new()
  $evidence = @{ stages = $stages }
  $expected = '0' * 64
  $rejected = $false
  try { Assert-Installed '1.5.0-alpha.1' $expected }
  catch {
    if ($_.Exception.Message -ne 'Installed candidate differs from captured installer payload hash.') { throw }
    $rejected = $true
  }
  $saved = Get-Content -LiteralPath (Join-Path $out 'result.json') -Raw | ConvertFrom-Json
  $row = $saved.stages[0]
  if (!$rejected -or $row.status -ne 'failed' -or $row.expectedSha256 -ne $expected -or $row.actualSha256 -ne (Get-FileHash -LiteralPath $exe).Hash -or $row.byteLength -ne 21 -or $row.registryIdentity[0].DisplayVersion -ne '1.5.0-alpha.1') { throw 'Mismatch evidence missing before throw' }
  Assert-Installed '1.5.0-alpha.1' (Get-FileHash -LiteralPath $exe).Hash
  if ($stages[1].status -ne 'passed') { throw 'Matching identity rejected' }
  function Assert-PeMachine { throw 'injected architecture failure' }
  try { Assert-Installed '1.5.0-alpha.1' $expected; throw 'Architecture gate bypassed' }
  catch { if ($_.Exception.Message -ne 'injected architecture failure') { throw } }
  $saved = Get-Content -LiteralPath (Join-Path $out 'result.json') -Raw | ConvertFrom-Json
  if ($saved.stages[2].actualSha256 -ne (Get-FileHash -LiteralPath $exe).Hash -or $saved.stages[2].status -ne 'failed') { throw 'Early identity failure lost hash evidence' }
} finally { [IO.File]::Delete($exe); [IO.File]::Delete((Join-Path $out 'result.json')); [IO.Directory]::Delete($out) }
`;
  const result = spawnSync('pwsh', ['-NoProfile', '-Command', command], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});


test('installer diagnostic inputs stay explicit and portable runs follow lifecycle', () => {
  const source = readFileSync(new URL('../scripts/test-windows-installers.ps1', import.meta.url), 'utf8');
  const capture = source.slice(source.indexOf('$inputs = [ordered]@{'));
  assert.match(capture, /\$inputs\['installed-candidate.exe'\] = \$exe/);
  assert.doesNotMatch(capture, /Copy-Item[^\n]*-Recurse/);
  assert.match(capture, /ReparsePoint/);
  assert.match(capture, /diagnosticErrors.Add/);
  const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  assert.ok(workflow.indexOf('Disposable runner install upgrade reinstall uninstall lifecycle') < workflow.indexOf('Packaged portable CLI (ten consecutive runs)'));
  assert.match(workflow, /Upload CLI and lifecycle evidence including failures\r?\n        if: always\(\)/);
});


test('installer trace is opt-in and runner fixture shares production contracts', () => {
  const source = readFileSync(new URL('../src-tauri/windows/installer.nsi', import.meta.url), 'utf8');
  assert.match(source, /; PURGEON_CONTRACT_BEGIN/);
  assert.match(source, /GetStdHandle/);
  assert.match(source, /WriteFile/);
  assert.match(source, /LOGPURGEON/);
  assert.doesNotMatch(source, /FileOpen.*PURGEON/);
  const fixture = readFileSync(new URL('../scripts/test-nsis-webview-launch.ps1', import.meta.url), 'utf8');
  assert.match(fixture, /RUNNER_ENVIRONMENT/);
  assert.match(fixture, /PURGEON_CONTRACT_BEGIN/);
  assert.match(fixture, /Get-FileHash/);
  const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  assert.ok(workflow.indexOf('test-nsis-webview-launch.ps1') > workflow.indexOf('npm run dist:windows'));
  assert.ok(workflow.indexOf('test-nsis-webview-launch.ps1') < workflow.indexOf('test-windows-installers.ps1'));
});


test('NSIS fixture refuses local runtime before creating output', { skip: process.platform !== 'win32' || process.env.GITHUB_ACTIONS === 'true' }, () => {
  const result = spawnSync('pwsh', ['-NoProfile', '-File', 'scripts/test-nsis-webview-launch.ps1'], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /restricted to disposable GitHub-hosted runners/);
});

test('lifecycle redirects every invocation and enables diagnostics only for candidate installers', () => {
  const command = `
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PWD 'scripts/test-windows-installers.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$function = $ast.Find({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Invoke-Installer' }, $true)
Invoke-Expression $function.Extent.Text
$out = Join-Path $PWD 'inert-mock-output'
$stages = [Collections.Generic.List[object]]::new()
$calls = [Collections.Generic.List[object]]::new()
function Get-FileHash { param($LiteralPath, $Algorithm) return @{ Hash = ('a' * 64) } }
function Test-Path { param($LiteralPath) return $false }
function Start-Process {
  param($FilePath, $ArgumentList, [switch]$PassThru, $WindowStyle, $RedirectStandardOutput, $RedirectStandardError)
  $calls.Add(@{ arguments = $ArgumentList; stdout = $RedirectStandardOutput; stderr = $RedirectStandardError })
  $process = [pscustomobject]@{ ExitCode = 0 }
  $process | Add-Member ScriptMethod WaitForExit { param($timeout) return $true }
  $process | Add-Member ScriptMethod Dispose { }
  return $process
}
foreach ($stage in @('install-prior', 'upgrade-candidate', 'reinstall-candidate', 'uninstall-candidate')) {
  Invoke-Installer 'inert-never-executed.exe' '/S /D=inert path' $stage
}
if ($calls[0].arguments.Contains('/LOGPURGEON') -or $calls[3].arguments.Contains('/LOGPURGEON')) { throw 'Prior or uninstaller received diagnostics flag' }
if (!$calls[1].arguments.StartsWith('/LOGPURGEON ') -or !$calls[2].arguments.StartsWith('/LOGPURGEON ')) { throw 'Candidate flag missing' }
if (@($calls.stdout | Select-Object -Unique).Count -ne 4 -or @($calls.stderr | Select-Object -Unique).Count -ne 4) { throw 'Invocation logs reused' }
foreach ($row in $stages) {
  if ($row.executableSha256 -ne ('a' * 64) -or $row.traceStatus -ne 'unavailable') { throw 'Identity or unavailable trace mislabeled' }
}
`;
  const result = spawnSync('pwsh', ['-NoProfile', '-Command', command], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('diagnostics flag cannot collide with actual FileFunc passive lookup', () => {
  const source = readFileSync(new URL('../src-tauri/windows/installer.nsi', import.meta.url), 'utf8');
  const flag = source.match(/GetOptions} \$CMDLINE "(\/LOGPURGEON)"/)[1];
  assert.ok(!flag.startsWith('/P'));
  assert.doesNotMatch(source, /PURGEONDIAGNOSTICS|AndIf} \$PassiveMode == ""/);
  const fixture = readFileSync(new URL('../scripts/test-nsis-webview-launch.ps1', import.meta.url), 'utf8');
  for (const name of ['flag-alone', 'flag-passive-first', 'flag-passive-last', 'flag-silent', 'flag-update', 'flag-noshortcut']) assert.ok(fixture.includes(name));
  assert.ok(fixture.includes('!include FileFunc.nsh'));
  assert.ok(fixture.includes(".Replace('@PASSIVE@', $script:passiveBlock)"));
});
