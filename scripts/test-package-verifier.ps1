param(
    [Parameter(Mandatory)][string] $Directory,
    [Parameter(Mandatory)][string] $Manifest,
    [string] $EvidenceDirectory
)
. "$PSScriptRoot/windows-package-tools.ps1"
$root = Split-Path $PSScriptRoot -Parent
$fixture = Join-Path $root ('out/package-verifier-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
Copy-Item -Path (Join-Path $Directory '*') -Destination $fixture
$testManifest = "$fixture-manifest.json"
Copy-Item -LiteralPath $Manifest -Destination $testManifest
if (!$EvidenceDirectory) { $EvidenceDirectory = "$((Resolve-Path -LiteralPath $Directory).Path)-evidence" }
$testEvidence = "$fixture-evidence"
New-Item -ItemType Directory -Path $testEvidence | Out-Null
foreach ($name in @('purgeon.exe','receipt.json')) { Copy-Item -LiteralPath (Join-Path $EvidenceDirectory $name) -Destination (Join-Path $testEvidence $name) }

function Expect-Failure([scriptblock] $Action, [string] $Message) {
    try { & $Action } catch {
        if ($_.Exception.Message -notlike "*$Message*") { throw }
        return
    }
    throw "Expected failure was accepted: $Message"
}
$verify = { & "$PSScriptRoot/verify-windows-package.ps1" -Directory $fixture -Manifest $testManifest -EvidenceDirectory $testEvidence }
& $verify

# Internal evidence is checked from the downloaded copy, independently of local build paths.
$payload = Join-Path $testEvidence 'purgeon.exe'
$original = [IO.File]::ReadAllBytes($payload)
[IO.File]::AppendAllText($payload, 'substitution')
Expect-Failure $verify 'hash/length mismatch'
[IO.File]::WriteAllBytes($payload, $original)
$savedManifest = Get-Content -LiteralPath $testManifest -Raw
$changed = $savedManifest | ConvertFrom-Json
$changed.installed.'purgeon.exe'.installerSha256 = '0' * 64
$changed | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $testManifest
Expect-Failure $verify 'installer binding'
Set-Content -LiteralPath $testManifest -Value $savedManifest

# A nonempty destination must be preserved rather than silently overwritten.
Expect-Failure { & "$PSScriptRoot/package-windows.ps1" -SkipBuild -OutputDirectory $fixture } 'must be empty'
$extra = Join-Path $fixture 'unexpected.txt'
Set-Content -LiteralPath $extra -Value 'extra asset'
Expect-Failure $verify 'exactly the two'
Remove-Item -LiteralPath $extra

$archivePath = Join-Path $fixture 'Purgeon-Portable-x64.zip'
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
$evidence.assets.'Purgeon-Portable-x64.zip' = (Get-FileHash -LiteralPath $archivePath).Hash
$evidence | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $testManifest -Encoding utf8
# Keep the receipt's outer artifact binding consistent to reach the inner-entry gate.
$receipt = Get-Content -LiteralPath "$testEvidence/receipt.json" -Raw | ConvertFrom-Json
$receipt.assets.'Purgeon-Portable-x64.zip' = $evidence.assets.'Purgeon-Portable-x64.zip'
$receipt | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath "$testEvidence/receipt.json"
Expect-Failure $verify 'Portable hash mismatch'
Write-Output 'Passed 6 negative packaging checks: payload substitution, installer binding, existing output, extra asset, changed ZIP and changed entry.'
