# Guest-only read of uninstall registration metadata. No installer or network access.
function Read-LabManifest([string]$root) {
    $path = Join-Path $root 'Lab.json'
    if ((Get-Item -LiteralPath $path).Length -gt 4096) { throw 'Lab manifest is oversized.' }
    $lab = [IO.File]::ReadAllText($path) | ConvertFrom-Json
    if ($lab.version -ne 1 -or $lab.id -cnotmatch '^[0-9a-f]{12}$' -or
        $lab.installer -cnotmatch '^Installer\.(exe|msi)$' -or
        $lab.sha256 -cnotmatch '^[0-9a-f]{64}$' -or $lab.bytes -lt 1 -or $lab.bytes -gt 1GB) {
        throw 'Invalid lab manifest.'
    }
    return $lab
}

function Get-LabStatePath([string]$id) {
    $dir = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'PurgeonDisposableLab'
    [void][IO.Directory]::CreateDirectory($dir)
    return Join-Path $dir "$id.json"
}

function Read-LabScope([string]$hive, [string]$view) {
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $base = $null
    $root = $null
    $algorithm = $null
    $rows = [ordered]@{}
    try {
        $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)
        $root = $base.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall', $false)
        if ($null -eq $root) { return @{ complete = $true; rows = $rows } }
        if ($root.SubKeyCount -gt 1024) { throw 'Registration count exceeds bounds.' }
        $names = $root.GetSubKeyNames()
        if ($names.Length -gt 1024) { throw 'Registration count exceeds bounds.' }
        $algorithm = [Security.Cryptography.SHA256]::Create()
        foreach ($name in $names) {
            if ($clock.ElapsedMilliseconds -gt 5000 -or $name.Length -gt 255) { throw 'Registration scan limit reached.' }
            $key = $root.OpenSubKey($name, $false)
            if ($null -eq $key) { throw 'Registration changed during the read.' }
            try {
                $values = foreach ($field in 'DisplayName', 'DisplayVersion', 'Publisher') {
                    $value = $key.GetValue($field, '', 'DoNotExpandEnvironmentNames')
                    if ($value -isnot [string] -or $value.Length -gt 512) { throw 'Unexpected registration metadata.' }
                    $value
                }
                $encoded = [Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject @($values) -Compress))
                $rows[$name] = [BitConverter]::ToString($algorithm.ComputeHash($encoded)).Replace('-', '')
            } finally { $key.Dispose() }
        }
        return @{ complete = $true; rows = $rows }
    } catch {
        return @{ complete = $false; rows = @{} }
    } finally {
        if ($null -ne $algorithm) { $algorithm.Dispose() }
        if ($null -ne $root) { $root.Dispose() }
        if ($null -ne $base) { $base.Dispose() }
    }
}

function Get-LabInventory {
    return @{
        lm64 = Read-LabScope LocalMachine Registry64
        lm32 = Read-LabScope LocalMachine Registry32
        cu = Read-LabScope CurrentUser Registry64
    }
}

function Read-LabBaseline([string]$path) {
    $file = [IO.File]::Open($path, 'Open', 'Read', 'Read')
    try {
        if ($file.Length -gt 3MB) { throw 'Guest baseline is oversized.' }
        $reader = [IO.StreamReader]::new($file)
        try { return $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
    } finally { $file.Dispose() }
}

function Get-ReportChecksum([string]$code) {
    [uint32]$hash = 2166136261
    foreach ($char in $code.ToCharArray()) {
        $hash = [uint32](([uint64]($hash -bxor [uint32]$char) * 16777619) -band 4294967295L)
    }
    return $hash.ToString('X8')
}

function New-LabReportCode([string]$id, $before, $after) {
    if ($id -cnotmatch '^[0-9a-f]{12}$') { throw 'Invalid lab identity.' }
    $coverage = 0
    $bit = 1
    $added = $missing = $changed = 0
    foreach ($scope in 'lm64', 'lm32', 'cu') {
        if ($before.$scope.complete -eq $true -and $after.$scope.complete -eq $true) {
            $coverage = $coverage -bor $bit
            $old = @{}
            $properties = @($before.$scope.rows.PSObject.Properties)
            if ($properties.Length -gt 1024) { throw 'Guest baseline is invalid.' }
            foreach ($entry in $properties) {
                if ($entry.Value -isnot [string] -or $entry.Value -cnotmatch '^[A-F0-9]{64}$') {
                    throw 'Guest baseline is invalid.'
                }
                $old[$entry.Name] = $entry.Value
            }
            $new = $after.$scope.rows
            foreach ($key in $new.Keys) {
                if (!$old.ContainsKey($key)) { $added++ }
                elseif ($old[$key] -cne $new[$key]) { $changed++ }
                [void]$old.Remove($key)
            }
            $missing += $old.Count
        }
        $bit = $bit -shl 1
    }
    $prefix = 'P1-{0}-{1:X1}-{2:X4}-{3:X4}-{4:X4}' -f $id.ToUpperInvariant(), $coverage, $added, $missing, $changed
    return "$prefix-$(Get-ReportChecksum $prefix)"
}
