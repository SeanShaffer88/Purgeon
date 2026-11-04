<#
.SYNOPSIS
Build the two x64 Windows release assets and sibling internal payload evidence.
.PARAMETER SkipBuild
Reuse only inputs and artifacts matching a complete prior receipt. Use a new output.
.PARAMETER EvidenceDirectory
Internal evidence destination (default: OutputDirectory-evidence). Must be outside
public assets; must be new for builds, or contain the prior receipt for SkipBuild.
#>
param(
    [switch] $SkipBuild,
    [string] $OutputDirectory = 'release',
    [string] $EvidenceDirectory
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/windows-package-tools.ps1"
$root = Split-Path $PSScriptRoot -Parent
Push-Location $root
try {
    $output = [IO.Path]::GetFullPath((Join-Path $PWD $OutputDirectory))
    if ([IO.Path]::IsPathRooted($OutputDirectory)) { $output = [IO.Path]::GetFullPath($OutputDirectory) }
    if (!$EvidenceDirectory) { $EvidenceDirectory = "$output-evidence" }
    $evidencePath = [IO.Path]::GetFullPath($EvidenceDirectory)
    if ($evidencePath.StartsWith($output.TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or $evidencePath -ieq $output) { throw 'Internal evidence must be outside the public output directory.' }
    if ((Test-Path -LiteralPath $output) -and @(Get-ChildItem -LiteralPath $output -Force).Count) { throw "Output directory must be empty: $output" }
    if (Test-Path -LiteralPath "$output-manifest.json") { throw "Output manifest already exists: $output-manifest.json. Select a new OutputDirectory." }
    if (!$SkipBuild -and (Test-Path -LiteralPath $evidencePath)) { throw "Evidence directory must be new: $evidencePath. Select a new EvidenceDirectory." }
    $signing = Get-PackageSigningBinding
    $version = (Get-Content package.json -Raw | ConvertFrom-Json).version
    $setupName = Get-NsisSetupName $version
    $x64 = Join-Path $root 'src-tauri/target/x86_64-pc-windows-msvc/release'
    $mainBinary = [IO.Path]::GetFullPath("$x64/purgeon.exe")
    $setup64 = Join-Path $x64 "bundle/nsis/$setupName"
    $inputs = Get-PackageInputBinding $root
    if (-not $SkipBuild) {
        $cliVersion = (Get-Content -LiteralPath "$root/node_modules/@tauri-apps/cli/package.json" -Raw | ConvertFrom-Json).version
        if ($cliVersion -cne '2.12.4') { throw 'Payload capture requires the verified Tauri CLI 2.12.4. Restore the pinned lockfile with npm ci before building.' }
        $buildId = [guid]::NewGuid().ToString('N')
        $captureDirectory = Join-Path $root "out/package-capture-$buildId"
        New-Item -ItemType Directory -Path $captureDirectory | Out-Null
        $captureContext = Join-Path $captureDirectory 'context.json'
        @{ buildId = $buildId; mainBinary = $mainBinary; signing = $signing } | ConvertTo-Json | Set-Content -LiteralPath $captureContext
        # Generate an absolute signing command; Tauri's working directory is irrelevant.
        $signConfig = Join-Path ([IO.Path]::GetTempPath()) ('purgeon-sign-config-' + [guid]::NewGuid() + '.json')
        try {
            @{ bundle = @{ windows = @{ signCommand = @{ cmd = 'pwsh'; args = @('-NoProfile', '-File', (Join-Path $PSScriptRoot 'sign-windows.ps1'), '-Binary', '%1', '-CaptureContext', $captureContext) } } } } |
                ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $signConfig -Encoding utf8
            & npm.cmd run dist -- --target x86_64-pc-windows-msvc --bundles nsis --ci --config $signConfig
            if ($LASTEXITCODE) { throw 'x64 bundle build failed.' }
        } finally { Remove-Item -LiteralPath $signConfig -Force -ErrorAction SilentlyContinue }
        $capture = Get-Content -LiteralPath "$captureDirectory/capture.json" -Raw | ConvertFrom-Json
        if ($capture.buildId -cne $buildId -or $capture.source -ine $mainBinary -or $capture.signing -cne $signing) { throw 'Installer payload capture does not match this build.' }
        Assert-PackageFileIdentity "$captureDirectory/purgeon.exe" $capture.payload
        # CLI 2.12.4 restores the original executable after the NSIS bundle.
        # Re-sign it separately, without a capture context, for the portable ZIP.
        if ($signing -ne 'unsigned') { & "$PSScriptRoot/sign-windows.ps1" -Binary $mainBinary }
        if ((Get-PackageInputBinding $root) -cne $inputs) { throw 'Packaging inputs changed during the build. Run a fresh build.' }
    } else {
        $receipt = Get-Content -LiteralPath "$evidencePath/receipt.json" -Raw | ConvertFrom-Json
        if ($receipt.schemaVersion -ne 2 -or $receipt.version -cne $version -or $receipt.target -cne 'x86_64-pc-windows-msvc' -or $receipt.signing -cne $signing -or $receipt.inputs -cne $inputs -or $receipt.mainBinary -ine $mainBinary -or $receipt.setupBinary -ine $setup64) { throw 'Stale package receipt. Run dist:windows without SkipBuild using a new output/evidence directory.' }
        Assert-PackageFileIdentity $mainBinary $receipt.portable
        Assert-PackageFileIdentity $setup64 $receipt.installer
        Assert-PackageFileIdentity "$evidencePath/purgeon.exe" $receipt.payload
        $priorManifest = @{ schemaVersion = 2; version = $receipt.version; assets = $receipt.assets;
            portable = @{ 'Purgeon-Portable-x64.exe' = $receipt.portable.sha256 };
            installed = @{ 'purgeon.exe' = @{ sha256 = $receipt.payload.sha256; byteLength = $receipt.payload.byteLength; machine = 0x8664; bundleType = 'nsis'; installerSha256 = $receipt.installer.sha256 } } }
        $null = Assert-InstalledPackageEvidence $priorManifest $evidencePath
        $capture = @{ payload = $receipt.payload }
        $buildId = $receipt.buildId
    }
    foreach ($path in @($setup64)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing package input: $path" }
    }
    Assert-PeMachine "$x64/purgeon.exe" 0x8664
    if ($env:CODE_SIGN_CERT -or $env:CODE_SIGN_PASSWORD) {
        foreach ($binary in @("$x64/purgeon.exe", $setup64)) {
            if ((Get-AuthenticodeSignature -LiteralPath $binary).Status -ne 'Valid') { throw "Final package input has no valid signature: $binary" }
        }
    }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zipPath = Join-Path ([IO.Path]::GetTempPath()) ('purgeon-package-' + [guid]::NewGuid().ToString('N') + '.zip')
    $zip = [IO.Compression.ZipFile]::Open($zipPath, [IO.Compression.ZipArchiveMode]::Create)
    try {
        $entries = [ordered]@{
            'Purgeon-Portable-x64.exe' = "$x64/purgeon.exe"
            'LICENSE' = "$root/LICENSE"
            'PORTABLE.txt' = "$root/PORTABLE.txt"
        }
        foreach ($entry in $entries.GetEnumerator()) {
            [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $entry.Value, $entry.Key) | Out-Null
        }
    } finally { $zip.Dispose() }
    $hashes = [ordered]@{
        'Purgeon-Setup-x64.exe' = (Get-FileHash -LiteralPath $setup64 -Algorithm SHA256).Hash
        'Purgeon-Portable-x64.zip' = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash
    }
    $portableHashes = [ordered]@{}
    foreach ($entry in $entries.GetEnumerator()) {
        $portableHashes[$entry.Key] = (Get-FileHash -LiteralPath $entry.Value -Algorithm SHA256).Hash
    }
    # CI evidence only: the two public release assets stay in the output folder.
    $manifest = "$output-manifest.json"
    $installed = @{ 'purgeon.exe' = @{ sha256 = $capture.payload.sha256; byteLength = $capture.payload.byteLength; machine = 0x8664; bundleType = 'nsis'; installerSha256 = $hashes['Purgeon-Setup-x64.exe'] } }
    if ($SkipBuild) {
        foreach ($name in $hashes.Keys) {
            if ($hashes[$name] -ne $receipt.assets.$name) { throw 'Repackaged artifact differs from receipt. Run a fresh build.' }
        }
    }
    if (!(Test-Path -LiteralPath $output)) { New-Item -ItemType Directory -Path $output | Out-Null }
    Copy-Item -LiteralPath $setup64 -Destination "$output/Purgeon-Setup-x64.exe"
    Copy-Item -LiteralPath $zipPath -Destination "$output/Purgeon-Portable-x64.zip"
    if (!$SkipBuild) {
        New-Item -ItemType Directory -Path $evidencePath | Out-Null
        Copy-Item -LiteralPath "$captureDirectory/purgeon.exe" -Destination "$evidencePath/purgeon.exe"
        @{ schemaVersion = 2; buildId = $buildId; version = $version; target = 'x86_64-pc-windows-msvc'; signing = $signing; inputs = $inputs; mainBinary = $mainBinary; setupBinary = $setup64;
            payload = $capture.payload; portable = (Get-PackageFileIdentity $mainBinary); installer = (Get-PackageFileIdentity $setup64); assets = $hashes } |
            ConvertTo-Json -Depth 6 | Set-Content -LiteralPath "$evidencePath/receipt.json" -Encoding utf8
    }
    @{ schemaVersion = 2; version = $version; assets = $hashes; portable = $portableHashes; installed = $installed } |
        ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifest -Encoding utf8
    & "$PSScriptRoot/verify-windows-package.ps1" -Directory $output -Manifest $manifest -EvidenceDirectory $evidencePath
} finally {
    if (Get-Variable zipPath -ErrorAction SilentlyContinue) { Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue }
    Pop-Location
}
