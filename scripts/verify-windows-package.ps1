param(
    [Parameter(Mandatory)][string] $Directory,
    [Parameter(Mandatory)][string] $Manifest
)
. "$PSScriptRoot/windows-package-tools.ps1"
$directoryPath = (Resolve-Path -LiteralPath $Directory).Path
$evidence = Get-Content -LiteralPath $Manifest -Raw | ConvertFrom-Json
$expected = @('Purgeon-Portable-x64.zip', 'Purgeon-Setup-x64.exe')
$actual = @(Get-ChildItem -LiteralPath $directoryPath -Force | Select-Object -ExpandProperty Name)
if (Compare-Object $expected $actual) { throw 'Release must contain exactly the two specified assets.' }
foreach ($name in $expected) {
    if ((Get-FileHash -LiteralPath "$directoryPath/$name" -Algorithm SHA256).Hash -ne $evidence.assets.$name) {
        throw "Asset hash mismatch: $name"
    }
}
Assert-PeMachine "$directoryPath/Purgeon-Setup-x64.exe" 0x8664

Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead("$directoryPath/Purgeon-Portable-x64.zip")
try {
    $names = @('Purgeon-Portable-x64.exe', 'LICENSE', 'PORTABLE.txt')
    if ($zip.Entries.Count -ne 3 -or (Compare-Object $names @($zip.Entries.FullName))) {
        throw 'Portable ZIP has missing, extra, duplicate or nested entries.'
    }
    foreach ($entry in $zip.Entries) {
        $stream = $entry.Open()
        $sha = [Security.Cryptography.SHA256]::Create()
        try {
            $hash = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '')
            if ($hash -ne $evidence.portable.($entry.FullName)) { throw "Portable hash mismatch: $($entry.FullName)" }
        } finally { $sha.Dispose(); $stream.Dispose() }
    }
    # The portable executable itself must be a native x64 build.
    $portableEntry = $zip.GetEntry('Purgeon-Portable-x64.exe')
    $tempExe = Join-Path ([IO.Path]::GetTempPath()) ('purgeon-portable-' + [Guid]::NewGuid().ToString('N') + '.exe')
    try {
        $in = $portableEntry.Open()
        $out = [IO.File]::Create($tempExe)
        try { $in.CopyTo($out) } finally { $out.Dispose(); $in.Dispose() }
        Assert-PeMachine $tempExe 0x8664
    } finally { Remove-Item -LiteralPath $tempExe -Force -ErrorAction SilentlyContinue }
} finally { $zip.Dispose() }
Write-Output "Verified two release assets and all three portable ZIP entries ($($evidence.version))."
