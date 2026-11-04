$ErrorActionPreference = 'Stop'
# The stdin handshake keeps all inspection behind native process containment.
$null = [Console]::In.ReadToEnd() | Microsoft.PowerShell.Utility\ConvertFrom-Json
$sources = New-Object Collections.Generic.List[object]
$records = New-Object Collections.Generic.List[object]
foreach ($class in @('AntiVirusProduct','AntiSpywareProduct','FirewallProduct')) {
    $id = 'SecurityCenter2/' + $class
    try {
        $items = @(CimCmdlets\Get-CimInstance -Namespace root/SecurityCenter2 -ClassName $class -OperationTimeoutSec 8 -ErrorAction Stop | Select-Object -First 129)
        if ($items.Count -gt 128) { throw 'SecurityCenter inventory exceeds bounds' }
        foreach ($item in $items) {
            $records.Add(@{name=([string]$item.displayName);publisher='';version='';source=$id;state=([string]$item.productState)})
        }
        $sources.Add(@{id=$id;status='ok';detail=''})
    } catch {
        $status = 'error'
        if ($_.Exception.Message -match 'Invalid namespace|Invalid class|0x8004100[Ee]|0x80041010') { $status = 'unavailable' }
        $sources.Add(@{id=$id;status=$status;detail='SecurityCenter query did not complete'})
    }
}
foreach ($hive in @('LocalMachine','CurrentUser')) {
    foreach ($view in @('Registry64','Registry32')) {
        $id = $hive + '/' + $view + '/Uninstall'
        $base = $null; $key = $null
        try {
            $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::$hive,[Microsoft.Win32.RegistryView]::$view)
            $key = $base.OpenSubKey('SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall')
            if (-not $key) { $sources.Add(@{id=$id;status='unavailable';detail='Uninstall key absent'}); continue }
            $names = $key.GetSubKeyNames()
            if ($names.Length -gt 4096) { throw 'Uninstall inventory exceeds bounds' }
            foreach ($name in $names) {
                $child = $null
                try {
                    $child = $key.OpenSubKey($name)
                    if (-not $child) { throw 'Uninstall entry became unavailable' }
                    $display = [string]$child.GetValue('DisplayName','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
                    if ($display) {
                        $publisher = [string]$child.GetValue('Publisher','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
                        $version = [string]$child.GetValue('DisplayVersion','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
                        if ($display.Length -gt 512 -or $publisher.Length -gt 512 -or $version.Length -gt 128) { throw 'Uninstall text exceeds bounds' }
                        $records.Add(@{name=$display;publisher=$publisher;version=$version;source=$id;state=''})
                    }
                } finally { if ($child) { $child.Dispose() } }
            }
            $sources.Add(@{id=$id;status='ok';detail=''})
        } catch { $sources.Add(@{id=$id;status='error';detail='Uninstall query incomplete'}) }
        finally { if ($key) { $key.Dispose() }; if ($base) { $base.Dispose() } }
    }
}
@{sources=@($sources.ToArray());records=@($records.ToArray())} | ConvertTo-Json -Depth 5 -Compress
