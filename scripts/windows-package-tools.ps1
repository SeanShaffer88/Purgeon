Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-NsisSetupName([string] $Version) {
    if ($Version -cnotmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-(alpha|beta|rc)\.(0|[1-9]\d*))?$') {
        throw 'Packaging requires a three-part version with an optional alpha.N, beta.N or rc.N prerelease.'
    }
    return "Purgeon_${Version}_x64-setup.exe"
}

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

function Get-PackageFileIdentity([string] $Path) {
    $file = Get-Item -LiteralPath $Path
    return [ordered]@{ sha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash; byteLength = $file.Length }
}

function Assert-PackageFileIdentity([string] $Path, $Identity) {
    $actual = Get-PackageFileIdentity $Path
    if ($actual.sha256 -ne $Identity.sha256 -or $actual.byteLength -ne $Identity.byteLength) {
        throw "Package evidence hash/length mismatch: $Path. Run a fresh Windows package build."
    }
}

function Get-PackageSigningBinding {
    if ([bool]$env:CODE_SIGN_CERT -ne [bool]$env:CODE_SIGN_PASSWORD) { throw 'Both signing credentials are required. Configure both or remove both for an unsigned build.' }
    if (!$env:CODE_SIGN_CERT) { return 'unsigned' }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return 'signed:' + [Convert]::ToHexString($sha.ComputeHash([Convert]::FromBase64String($env:CODE_SIGN_CERT))) }
    finally { $sha.Dispose() }
}

function Get-PackageInputBinding([string] $Root) {
    # Include application, native and packaging inputs, excluding generated trees.
    $files = [Collections.Generic.List[string]]::new()
    foreach ($folder in @('src', 'packages/purgeon-core/src', 'src-tauri/src', 'src-tauri/capabilities', 'src-tauri/icons', 'src-tauri/windows', '.cargo', 'src-tauri/.cargo', 'scripts', 'public')) {
        $path = Join-Path $Root $folder
        if (Test-Path -LiteralPath $path) {
            foreach ($file in Get-ChildItem -LiteralPath $path -File -Recurse) { $files.Add($file.FullName) }
        }
    }
    foreach ($name in @('package.json','package-lock.json','packages/purgeon-core/package.json','src-tauri/Cargo.toml','src-tauri/Cargo.lock','src-tauri/build.rs','src-tauri/build_support.rs','src-tauri/app.manifest','src-tauri/tauri.conf.json','vite.config.js','tsconfig.json','index.html','LICENSE','PORTABLE.txt')) {
        $path = Join-Path $Root $name
        if (Test-Path -LiteralPath $path -PathType Leaf) { $files.Add($path) }
    }
    $binding = [ordered]@{}
    foreach ($file in $files | Sort-Object -Unique) {
        $binding[[IO.Path]::GetRelativePath($Root, $file).Replace('\','/')] = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
    }
    return ($binding | ConvertTo-Json -Compress)
}

function Save-InstallerPayload([string] $Binary, [string] $CaptureContext) {
    if (!$CaptureContext) { return }
    $context = Get-Content -LiteralPath $CaptureContext -Raw | ConvertFrom-Json
    $source = (Resolve-Path -LiteralPath $Binary).Path
    if ($source -ine $context.mainBinary) { return } # Plugins/installers/uninstallers are ordinary signing callbacks.
    if ($context.buildId -cnotmatch '^[a-f0-9]{32}$' -or $context.signing -ne (Get-PackageSigningBinding)) { throw 'Invalid capture context. Run a fresh Windows package build.' }
    $directory = Split-Path $CaptureContext -Parent
    $destination = Join-Path $directory 'purgeon.exe'
    $receipt = Join-Path $directory 'capture.json'
    if ((Test-Path -LiteralPath $destination) -or (Test-Path -LiteralPath $receipt)) { throw 'Duplicate installer payload capture. Run a fresh Windows package build.' }
    # Deny writes while hashing/copying; create-new also rejects competing callbacks.
    $input = [IO.File]::Open($source, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        $before = Get-PackageFileIdentity $source
        $output = [IO.File]::Open($destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $input.CopyTo($output) } finally { $output.Dispose() }
        Assert-PackageFileIdentity $source $before
        Assert-PackageFileIdentity $destination $before
        Assert-PeMachine $destination 0x8664
        $record = @{ buildId = $context.buildId; source = $source; payload = $before; signing = $context.signing }
        $writer = [IO.StreamWriter]::new([IO.File]::Open($receipt, [IO.FileMode]::CreateNew))
        try { $writer.Write(($record | ConvertTo-Json -Depth 5)) } finally { $writer.Dispose() }
    } finally { $input.Dispose() }
}

function Assert-InstalledPackageEvidence($Manifest, [string] $EvidenceDirectory) {
    if ($Manifest.schemaVersion -ne 2) { throw 'Package manifest schema 2 is required. Rebuild the package.' }
    $installed = $Manifest.installed.'purgeon.exe'
    if ($installed.machine -ne 0x8664 -or $installed.bundleType -cne 'nsis' -or $installed.installerSha256 -ne $Manifest.assets.'Purgeon-Setup-x64.exe') { throw 'Installed payload installer binding is invalid. Rebuild the package.' }
    $payload = Join-Path $EvidenceDirectory 'purgeon.exe'
    Assert-PackageFileIdentity $payload $installed
    Assert-PeMachine $payload 0x8664
    $receipt = Get-Content -LiteralPath (Join-Path $EvidenceDirectory 'receipt.json') -Raw | ConvertFrom-Json
    if ($receipt.signing -cnotmatch '^(unsigned|signed:[A-F0-9]{64})$' -or !$receipt.inputs -or !$receipt.mainBinary -or !$receipt.setupBinary) { throw 'Incomplete package receipt. Run a fresh Windows package build.' }
    foreach ($identity in @($receipt.payload, $receipt.portable, $receipt.installer)) {
        if ($identity.sha256 -notmatch '^[A-Fa-f0-9]{64}$' -or $identity.byteLength -lt 64) { throw 'Invalid package receipt file identity. Run a fresh Windows package build.' }
    }
    foreach ($name in @('Purgeon-Setup-x64.exe','Purgeon-Portable-x64.zip')) {
        if ($receipt.assets.$name -notmatch '^[A-Fa-f0-9]{64}$') { throw 'Incomplete receipt artifact hashes. Run a fresh Windows package build.' }
    }
    if ($receipt.schemaVersion -ne 2 -or $receipt.buildId -cnotmatch '^[a-f0-9]{32}$' -or $receipt.version -cne $Manifest.version -or $receipt.target -cne 'x86_64-pc-windows-msvc' -or
        $receipt.payload.sha256 -ne $installed.sha256 -or $receipt.payload.byteLength -ne $installed.byteLength -or
        $receipt.installer.sha256 -ne $installed.installerSha256 -or $receipt.portable.sha256 -ne $Manifest.portable.'Purgeon-Portable-x64.exe' -or
        $receipt.assets.'Purgeon-Setup-x64.exe' -ne $Manifest.assets.'Purgeon-Setup-x64.exe' -or $receipt.assets.'Purgeon-Portable-x64.zip' -ne $Manifest.assets.'Purgeon-Portable-x64.zip') {
        throw 'Package receipt artifact binding mismatch. Rebuild or download matching evidence.'
    }
    # Download validation intentionally never resolves the build machine's source paths.
    return $receipt
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
        [void] $view.Execute()
        $record = $view.Fetch()
        if (-not $record) { throw "Missing MSI property: $Name" }
        return $record.StringData(1)
    } finally { [void] $view.Close() }
}
