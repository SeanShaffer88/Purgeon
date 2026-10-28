param(
    [switch] $SkipBuild,
    [string] $OutputDirectory = 'release'
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/windows-package-tools.ps1"
$root = Split-Path $PSScriptRoot -Parent
Push-Location $root
try {
    $version = (Get-Content package.json -Raw | ConvertFrom-Json).version
    if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Packaging requires a three-part release version.' }
    if (-not $SkipBuild) {
        & npm.cmd run dist -- --target x86_64-pc-windows-msvc --bundles nsis --ci
        if ($LASTEXITCODE) { throw 'x64 bundle build failed.' }
    }
    $x64 = Join-Path $root 'src-tauri/target/x86_64-pc-windows-msvc/release'
    $setup64 = Join-Path $x64 "bundle/nsis/Purgeon_${version}_x64-setup.exe"
    foreach ($path in @($setup64)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing package input: $path" }
    }
    Assert-PeMachine "$x64/purgeon.exe" 0x8664
    if (Test-Path -LiteralPath $OutputDirectory) {
        if (@(Get-ChildItem -LiteralPath $OutputDirectory -Force).Count) {
            throw "Output directory must be empty: $OutputDirectory"
        }
    } else { New-Item -ItemType Directory -Path $OutputDirectory | Out-Null }
    $output = (Resolve-Path -LiteralPath $OutputDirectory).Path
    Copy-Item -LiteralPath $setup64 -Destination "$output/Purgeon-Setup-x64.exe"

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zipPath = Join-Path $output 'Purgeon-Portable-x64.zip'
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
    $hashes = [ordered]@{}
    foreach ($file in Get-ChildItem -LiteralPath $output -File) {
        $hashes[$file.Name] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
    }
    $portableHashes = [ordered]@{}
    foreach ($entry in $entries.GetEnumerator()) {
        $portableHashes[$entry.Key] = (Get-FileHash -LiteralPath $entry.Value -Algorithm SHA256).Hash
    }
    # CI evidence only: the two public release assets stay in the output folder.
    $manifest = "$output-manifest.json"
    @{ version = $version; assets = $hashes; portable = $portableHashes } |
        ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $manifest -Encoding utf8
    & "$PSScriptRoot/verify-windows-package.ps1" -Directory $output -Manifest $manifest
} finally { Pop-Location }
