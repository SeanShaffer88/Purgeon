Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-PeMachine([string] $Path) {
    $stream = [IO.File]::OpenRead($Path)
    $reader = [IO.BinaryReader]::new($stream)
    try {
        if ($stream.Length -lt 64 -or $reader.ReadUInt16() -ne 0x5A4D) {
            throw "Not a Windows executable: $Path"
        }
        $stream.Position = 0x3C
        $peOffset = $reader.ReadUInt32()
        if ($peOffset -gt $stream.Length - 6) { throw "Invalid PE offset: $Path" }
        $stream.Position = $peOffset
        if ($reader.ReadUInt32() -ne 0x4550) { throw "Invalid PE signature: $Path" }
        return $reader.ReadUInt16()
    } finally { $reader.Dispose() }
}

function Assert-PeMachine([string] $Path, [int] $Machine) {
    if ((Get-PeMachine $Path) -ne $Machine) { throw "Wrong architecture: $Path" }
}

function Get-NsisCompiler {
    $command = Get-Command makensis.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $candidates = @(
        "$env:LOCALAPPDATA/tauri/NSIS/makensis.exe",
        "$env:LOCALAPPDATA/tauri/NSIS/Bin/makensis.exe",
        "${env:ProgramFiles(x86)}/NSIS/makensis.exe"
    )
    foreach ($path in $candidates) { if (Test-Path -LiteralPath $path) { return $path } }
    throw 'NSIS compiler not found. Build a Tauri NSIS bundle first or put makensis.exe on PATH.'
}

function Get-MsiProperty($Database, [string] $Name) {
    $view = $Database.OpenView("SELECT ``Value`` FROM ``Property`` WHERE ``Property`` = '$Name'")
    try {
        $view.Execute()
        $record = $view.Fetch()
        if (-not $record) { throw "Missing MSI property: $Name" }
        return $record.StringData(1)
    } finally { $view.Close() }
}
