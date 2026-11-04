import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('installer capture and receipt reject substitutions and stale reuse using inert PE fixtures', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'purgeon-package-test-'));
  mkdirSync(path.join(root, 'scripts'));
  for (const name of ['windows-package-tools.ps1', 'sign-windows.ps1', 'package-windows.ps1', 'verify-windows-package.ps1', 'test-package-verifier.ps1']) {
    copyFileSync(new URL(`../scripts/${name}`, import.meta.url), path.join(root, 'scripts', name));
  }
  const command = String.raw`
$ErrorActionPreference = 'Stop'
. ./scripts/windows-package-tools.ps1
$env:CODE_SIGN_CERT = $null; $env:CODE_SIGN_PASSWORD = $null
function Reject([scriptblock] $action, [string] $message) {
  $failed = $false
  try { & $action } catch { $failed = $true; if ($_.Exception.Message -notlike "*$message*") { throw } }
  if (!$failed) { throw "Expected rejection: $message" }
}
function Write-Pe([string] $path, [int] $machine, [byte] $variant) {
  $bytes = [byte[]]::new(128); $bytes[0] = 0x4d; $bytes[1] = 0x5a; $bytes[60] = 64
  $bytes[64] = 0x50; $bytes[65] = 0x45; $bytes[68] = $machine -band 255; $bytes[69] = $machine -shr 8; $bytes[127] = $variant
  [IO.File]::WriteAllBytes($path, $bytes)
}
$main = Join-Path $PWD 'src-tauri/target/x86_64-pc-windows-msvc/release/purgeon.exe'
$setup = Join-Path (Split-Path $main) 'bundle/nsis/Purgeon_1.5.0-alpha.1_x64-setup.exe'
[void][IO.Directory]::CreateDirectory((Split-Path $setup))
Write-Pe $main 0x8664 1; Write-Pe $setup 0x14c 2
[void][IO.Directory]::CreateDirectory((Join-Path $PWD 'capture'))
$context = Join-Path $PWD 'capture/context.json'
$buildId = 'a' * 32
@{ buildId = $buildId; mainBinary = $main; signing = 'unsigned' } | ConvertTo-Json | Set-Content $context
& ./scripts/sign-windows.ps1 -Binary $setup -CaptureContext $context
if (Test-Path ./capture/purgeon.exe) { throw 'Installer callback captured as application' }
& ./scripts/sign-windows.ps1 -Binary $main -CaptureContext $context
Reject { & ./scripts/sign-windows.ps1 -Binary $main -CaptureContext $context } 'Duplicate'
$captured = Get-Content ./capture/capture.json -Raw | ConvertFrom-Json
Assert-PackageFileIdentity ./capture/purgeon.exe $captured.payload
Reject { Assert-PackageFileIdentity ./capture/missing.exe $captured.payload } 'does not exist'
[IO.File]::AppendAllText((Join-Path $PWD 'capture/purgeon.exe'), 'corrupt')
Reject { Assert-PackageFileIdentity ./capture/purgeon.exe $captured.payload } 'mismatch'
[IO.File]::Copy($main, (Join-Path $PWD 'capture/purgeon.exe'), $true)
$env:CODE_SIGN_CERT = 'partial'
Reject { & ./scripts/sign-windows.ps1 -Binary $main -CaptureContext $context } 'Both signing credentials'
$env:CODE_SIGN_CERT = $null
# Failing signer adapters exercise the real hook's error and cleanup flow.
# No certificate is imported and no real signing executable is invoked.
[void][IO.Directory]::CreateDirectory((Join-Path $PWD 'x64'))
$signer = Join-Path $PWD 'x64/signtool.ps1'
'$global:LASTEXITCODE = if ($args[0] -eq $env:PURGEON_FIXTURE_SIGN_FAILURE) { 1 } else { 0 }' | Set-Content $signer
foreach ($failure in @('sign','verify')) {
  & {
    function Get-ChildItem { [pscustomobject]@{ FullName = $signer } }
    $env:CODE_SIGN_CERT = 'Zml4dHVyZQ=='; $env:CODE_SIGN_PASSWORD = 'inert-fixture'
    $env:PURGEON_FIXTURE_SIGN_FAILURE = $failure
    try { Reject { & ./scripts/sign-windows.ps1 -Binary $main -CaptureContext $context } 'failed' }
    finally { $env:CODE_SIGN_CERT = $null; $env:CODE_SIGN_PASSWORD = $null; $env:PURGEON_FIXTURE_SIGN_FAILURE = $null }
  }
}
# A changed source identity between pre-copy and post-copy checks cannot seal capture.
[void][IO.Directory]::CreateDirectory((Join-Path $PWD 'changed-capture'))
$changedContext = Join-Path $PWD 'changed-capture/context.json'
Copy-Item $context $changedContext
& {
  $identityFunction = (Get-Command Get-PackageFileIdentity).ScriptBlock
  $script:identityCalls = 0
  function Get-PackageFileIdentity([string] $Path) {
    $script:identityCalls++
    $identity = & $identityFunction $Path
    if ($script:identityCalls -eq 2) { $identity.sha256 = '0' * 64 }
    return $identity
  }
  Reject { Save-InstallerPayload $main $changedContext } 'mismatch'
  if (Test-Path ./changed-capture/capture.json) { throw 'Source mutation sealed capture' }
}
# Model the restored portable variant without patching real application artifacts.
Write-Pe $main 0x8664 3
if ((Get-FileHash $main).Hash -eq $captured.payload.sha256) { throw 'Fixture variants must differ' }
'{"version":"1.5.0-alpha.1"}' | Set-Content ./package.json
'license fixture' | Set-Content ./LICENSE
'portable fixture' | Set-Content ./PORTABLE.txt
'build helper fixture' | Set-Content ./src-tauri/build_support.rs
'application manifest fixture' | Set-Content ./src-tauri/app.manifest
[void][IO.Directory]::CreateDirectory((Join-Path $PWD 'release'))
[void][IO.Directory]::CreateDirectory((Join-Path $PWD 'release-evidence'))
Copy-Item $setup ./release/Purgeon-Setup-x64.exe
Copy-Item ./capture/purgeon.exe ./release-evidence/purgeon.exe
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::Open((Join-Path $PWD 'release/Purgeon-Portable-x64.zip'), [IO.Compression.ZipArchiveMode]::Create)
$entries = [ordered]@{ 'Purgeon-Portable-x64.exe' = $main; 'LICENSE' = (Join-Path $PWD 'LICENSE'); 'PORTABLE.txt' = (Join-Path $PWD 'PORTABLE.txt') }
$portable = [ordered]@{}
try { foreach ($entry in $entries.GetEnumerator()) {
  [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $entry.Value, $entry.Key)
  $portable[$entry.Key] = (Get-FileHash $entry.Value).Hash
} } finally { $zip.Dispose() }
$assets = @{ 'Purgeon-Setup-x64.exe' = (Get-FileHash ./release/Purgeon-Setup-x64.exe).Hash; 'Purgeon-Portable-x64.zip' = (Get-FileHash ./release/Purgeon-Portable-x64.zip).Hash }
$installed = @{ 'purgeon.exe' = @{ sha256 = $captured.payload.sha256; byteLength = 128; machine = 0x8664; bundleType = 'nsis'; installerSha256 = $assets.'Purgeon-Setup-x64.exe' } }
$manifest = @{ schemaVersion = 2; version = '1.5.0-alpha.1'; assets = $assets; portable = $portable; installed = $installed }
$manifest | ConvertTo-Json -Depth 6 | Set-Content ./release-manifest.json
$receipt = @{ schemaVersion = 2; version = $manifest.version; target = 'x86_64-pc-windows-msvc'; buildId = $buildId; signing = 'unsigned'; inputs = (Get-PackageInputBinding $PWD.Path); mainBinary = $main; setupBinary = $setup; payload = $captured.payload; portable = (Get-PackageFileIdentity $main); installer = (Get-PackageFileIdentity $setup); assets = $assets }
$receipt | ConvertTo-Json -Depth 6 | Set-Content ./release-evidence/receipt.json
& ./scripts/verify-windows-package.ps1 -Directory release -Manifest release-manifest.json
& ./scripts/test-package-verifier.ps1 -Directory release -Manifest release-manifest.json
$downloadSetup = Join-Path $PWD 'release/Purgeon-Setup-x64.exe'
$downloadSetupBytes = [IO.File]::ReadAllBytes($downloadSetup)
Write-Pe $downloadSetup 0x14c 7
Reject { & ./scripts/verify-windows-package.ps1 -Directory release -Manifest release-manifest.json } 'Asset hash mismatch'
[IO.File]::WriteAllBytes($downloadSetup, $downloadSetupBytes)
# Installed evidence cannot accidentally accept only the portable hash.
Copy-Item $main ./release-evidence/purgeon.exe -Force
Reject { & ./scripts/verify-windows-package.ps1 -Directory release -Manifest release-manifest.json } 'mismatch'
Copy-Item ./capture/purgeon.exe ./release-evidence/purgeon.exe -Force
# Download verification accepts foreign workspace paths, but not substituted artifacts.
$receipt.mainBinary = 'D:/foreign/workspace/purgeon.exe'; $receipt.setupBinary = 'D:/foreign/workspace/setup.exe'
$receipt | ConvertTo-Json -Depth 6 | Set-Content ./release-evidence/receipt.json
& ./scripts/verify-windows-package.ps1 -Directory release -Manifest release-manifest.json
$receipt.mainBinary = $main; $receipt.setupBinary = $setup
$receipt | ConvertTo-Json -Depth 6 | Set-Content ./release-evidence/receipt.json
& ./scripts/package-windows.ps1 -SkipBuild -OutputDirectory repacked -EvidenceDirectory ./release-evidence
foreach ($name in @('build_support.rs','app.manifest')) {
  $inputPath = Join-Path $PWD "src-tauri/$name"
  $originalBytes = [IO.File]::ReadAllBytes($inputPath)
  $outputDirectory = "stale-$name"
  try {
    [IO.File]::AppendAllText($inputPath, 'changed')
    Reject { & ./scripts/package-windows.ps1 -SkipBuild -OutputDirectory $outputDirectory -EvidenceDirectory ./release-evidence } 'Stale'
    if (Test-Path $outputDirectory) { throw "Stale input reuse created output: $name" }
  } finally { [IO.File]::WriteAllBytes($inputPath, $originalBytes) }
}
$portableBytes = [IO.File]::ReadAllBytes($main)
Write-Pe $main 0x8664 9
Reject { & ./scripts/package-windows.ps1 -SkipBuild -OutputDirectory altered-binary -EvidenceDirectory ./release-evidence } 'mismatch'
[IO.File]::WriteAllBytes($main, $portableBytes)
$setupBytes = [IO.File]::ReadAllBytes($setup)
Write-Pe $setup 0x14c 9
Reject { & ./scripts/package-windows.ps1 -SkipBuild -OutputDirectory altered-setup -EvidenceDirectory ./release-evidence } 'mismatch'
[IO.File]::WriteAllBytes($setup, $setupBytes)
$env:CODE_SIGN_CERT = 'Zml4dHVyZQ=='; $env:CODE_SIGN_PASSWORD = 'inert-fixture'
try { Reject { & ./scripts/package-windows.ps1 -SkipBuild -OutputDirectory altered-signing -EvidenceDirectory ./release-evidence } 'Stale' }
finally { $env:CODE_SIGN_CERT = $null; $env:CODE_SIGN_PASSWORD = $null }
$receipt.buildId = ''
$receipt | ConvertTo-Json -Depth 6 | Set-Content ./release-evidence/receipt.json
Reject { & ./scripts/package-windows.ps1 -SkipBuild -OutputDirectory partial-receipt -EvidenceDirectory ./release-evidence } 'binding'
$receipt.buildId = $buildId
$receipt | ConvertTo-Json -Depth 6 | Set-Content ./release-evidence/receipt.json
'changed' | Add-Content ./PORTABLE.txt
Reject { & ./scripts/package-windows.ps1 -SkipBuild -OutputDirectory stale -EvidenceDirectory ./release-evidence } 'Stale'
if (Test-Path ./stale) { throw 'Stale reuse created output' }
Reject { & ./scripts/package-windows.ps1 -SkipBuild -OutputDirectory absent -EvidenceDirectory ./missing-evidence } 'does not exist'
if (Test-Path ./absent) { throw 'Missing receipt created output' }
foreach ($name in @('altered-binary','altered-setup','altered-signing','partial-receipt')) {
  if (Test-Path $name) { throw "Rejected reuse created output: $name" }
}
Write-Output 'Inert capture, independent payloads, download binding and SkipBuild checks passed.'
`;
  try {
    const result = spawnSync('pwsh', ['-NoProfile', '-Command', command], { cwd: root, encoding: 'utf8', timeout: 60000, windowsHide: true });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
