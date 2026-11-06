# Run manually inside the disposable guest.
$ErrorActionPreference = 'Stop'
if ($PSScriptRoot -ine 'C:\PurgeonLab') { throw 'Run this helper from C:\PurgeonLab inside Windows Sandbox.' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
try {
    if (($identity.Name -split '\\')[-1] -ine 'WDAGUtilityAccount') {
        throw 'This helper requires the Windows Sandbox guest account.'
    }
} finally { $identity.Dispose() }
. (Join-Path $PSScriptRoot 'Inventory.ps1')
$lab = Read-LabManifest $PSScriptRoot
$installer = Join-Path $PSScriptRoot $lab.installer
if ((Get-Item -LiteralPath $installer).Length -ne $lab.bytes -or
    (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash -ine $lab.sha256) {
    throw 'The staged installer no longer matches the manifest.'
}
$baseline = Get-LabStatePath $lab.id
$snapshot = Get-LabInventory | ConvertTo-Json -Depth 5 -Compress
$file = [IO.File]::Open($baseline, 'CreateNew', 'Write', 'None')
try {
    $bytes = [Text.Encoding]::UTF8.GetBytes($snapshot)
    $file.Write($bytes, 0, $bytes.Length)
    $file.Flush($true)
} finally { $file.Dispose() }
Write-Host "Baseline captured. You can manually run $installer inside this guest."
