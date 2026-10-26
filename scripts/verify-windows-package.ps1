param(
    [Parameter(Mandatory)][string] $Directory,
    [Parameter(Mandatory)][string] $Manifest
)
. "$PSScriptRoot/windows-package-tools.ps1"
$directoryPath = (Resolve-Path -LiteralPath $Directory).Path
$evidence = Get-Content -LiteralPath $Manifest -Raw | ConvertFrom-Json
$expected = @('Purgeon-Portable.zip', 'Purgeon-Setup.exe', 'Purgeon-Setup.msi')
$actual = @(Get-ChildItem -LiteralPath $directoryPath -Force | Select-Object -ExpandProperty Name)
if (Compare-Object $expected $actual) { throw 'Release must contain exactly the three specified assets.' }
foreach ($name in $expected) {
    if ((Get-FileHash -LiteralPath "$directoryPath/$name" -Algorithm SHA256).Hash -ne $evidence.assets.$name) {
        throw "Asset hash mismatch: $name"
    }
}
Assert-PeMachine "$directoryPath/Purgeon-Setup.exe" 0x14C

$installer = New-Object -ComObject WindowsInstaller.Installer
$database = $installer.OpenDatabase("$directoryPath/Purgeon-Setup.msi", 0)
if ($database.SummaryInformation(0).Property(7) -notmatch '^Intel;') {
    throw 'The universal-compatible MSI must be an x86 package.'
}
if ((Get-MsiProperty $database 'ProductName') -ne 'Purgeon' -or
    (Get-MsiProperty $database 'ProductVersion') -ne $evidence.version) {
    throw 'MSI product name/version does not match the release.'
}
foreach ($action in @('RemovePurgeonSignIn', 'RemovePurgeonMaintenance', 'RemoveLegacySignIn', 'RemoveLegacyMaintenance')) {
    $view = $database.OpenView("SELECT ``Condition`` FROM ``InstallExecuteSequence`` WHERE ``Action`` = '$action'")
    try {
        $view.Execute()
        $record = $view.Fetch()
        if (-not $record -or $record.StringData(1) -ne 'Installed AND REMOVE="ALL" AND NOT UPGRADINGPRODUCTCODE') {
            throw "Missing or unsafe MSI uninstall condition: $action"
        }
    } finally { $view.Close() }
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead("$directoryPath/Purgeon-Portable.zip")
try {
    $names = @('Purgeon-Portable-x86.exe', 'Purgeon-Portable-x64.exe', 'LICENSE', 'PORTABLE.txt')
    if ($zip.Entries.Count -ne 4 -or (Compare-Object $names @($zip.Entries.FullName))) {
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
} finally { $zip.Dispose() }
Write-Output "Verified three release assets, x86 MSI metadata/uninstall conditions, and all four portable ZIP entries ($($evidence.version))."
