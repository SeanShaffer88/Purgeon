# Run manually inside the same disposable guest after closing the installer.
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
$baseline = Get-LabStatePath $lab.id
$before = Read-LabBaseline $baseline
$after = Get-LabInventory
$code = New-LabReportCode $lab.id $before $after
Write-Host 'Type this observational code into Purgeon before closing Windows Sandbox:'
Write-Host $code
