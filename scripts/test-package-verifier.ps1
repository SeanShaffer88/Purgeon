param(
    [Parameter(Mandatory)][string] $Directory,
    [Parameter(Mandatory)][string] $Manifest
)
. "$PSScriptRoot/windows-package-tools.ps1"
$root = Split-Path $PSScriptRoot -Parent
$fixture = Join-Path $root ('out/package-verifier-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
Copy-Item -Path (Join-Path $Directory '*') -Destination $fixture
$testManifest = "$fixture-manifest.json"
Copy-Item -LiteralPath $Manifest -Destination $testManifest

function Expect-Failure([scriptblock] $Action, [string] $Message) {
    try { & $Action } catch {
        if ($_.Exception.Message -notlike "*$Message*") { throw }
        return
    }
    throw "Expected failure was accepted: $Message"
}
$verify = { & "$PSScriptRoot/verify-windows-package.ps1" -Directory $fixture -Manifest $testManifest }

# A nonempty destination must be preserved rather than silently overwritten.
Expect-Failure { & "$PSScriptRoot/package-windows.ps1" -SkipBuild -OutputDirectory $fixture } 'must be empty'
$extra = Join-Path $fixture 'unexpected.txt'
Set-Content -LiteralPath $extra -Value 'extra asset'
Expect-Failure $verify 'exactly the three'
Remove-Item -LiteralPath $extra

$archivePath = Join-Path $fixture 'Purgeon-Portable.zip'
$archive = [IO.Compression.ZipFile]::Open($archivePath, [IO.Compression.ZipArchiveMode]::Update)
try {
    $archive.GetEntry('PORTABLE.txt').Delete()
    $entry = $archive.CreateEntry('PORTABLE.txt')
    $writer = [IO.StreamWriter]::new($entry.Open())
    try { $writer.Write('Changed portable instructions') } finally { $writer.Dispose() }
} finally { $archive.Dispose() }
Expect-Failure $verify 'Asset hash mismatch'

# Even if someone recomputes the outer ZIP hash, each original entry is checked.
$evidence = Get-Content -LiteralPath $testManifest -Raw | ConvertFrom-Json
$evidence.assets.'Purgeon-Portable.zip' = (Get-FileHash -LiteralPath $archivePath).Hash
$evidence | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $testManifest -Encoding utf8
Expect-Failure $verify 'Portable hash mismatch'
Write-Output 'Passed 4 negative packaging checks: existing output, extra asset, changed ZIP and changed entry.'
