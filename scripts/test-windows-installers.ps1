param(
    [Parameter(Mandatory)][string] $Directory,
    [Parameter(Mandatory)][string] $Manifest,
    [Parameter(Mandatory)][string] $PriorInstaller,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-fA-F]{64}$')][string] $PriorSha256,
    [Parameter(Mandatory)][version] $PriorVersion,
    [string] $OutputDirectory = (Join-Path $PWD 'verification/installer'),
    [switch] $Reinstall
)
. "$PSScriptRoot/windows-package-tools.ps1"
function Get-InstallerBaseVersion([string] $Version) {
    [void](Get-NsisSetupName $Version)
    return [version]($Version -split '-', 2)[0]
}
function Assert-InstallerVersion([string] $Actual, [string] $Expected) {
    [void](Get-InstallerBaseVersion $Expected)
    if ($Actual -cne $Expected) { throw "Installed version $Actual differs from $Expected" }
}
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'Installer lifecycle tests are restricted to disposable GitHub-hosted runners.'
}
if ((Get-FileHash -LiteralPath $PriorInstaller -Algorithm SHA256).Hash -ne $PriorSha256) { throw 'Prior installer SHA256 mismatch; no installer executed.' }
& "$PSScriptRoot/verify-windows-package.ps1" -Directory $Directory -Manifest $Manifest
$package = Get-Content -LiteralPath $Manifest -Raw | ConvertFrom-Json
if ((Get-InstallerBaseVersion $package.version) -le $PriorVersion) { throw 'Candidate must be newer than prior installer.' }
if (Test-Path -LiteralPath $OutputDirectory) { throw 'Installer evidence destination must be new.' }
$out = (New-Item -ItemType Directory -Path $OutputDirectory).FullName
$testRoot = Join-Path $env:RUNNER_TEMP ('purgeon-installer-tests-' + [Guid]::NewGuid().ToString('N'))
$install = Join-Path $testRoot 'EXE install with spaces'
$data = Join-Path $env:APPDATA 'com.seanshaffer.sweepuninstall'
$portable = Join-Path $testRoot 'external portable/Purgeon Data'
$exe = Join-Path $install 'purgeon.exe'
$registries = @('HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Purgeon', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Purgeon')
$stages = [Collections.Generic.List[object]]::new()
$evidence = [ordered]@{ status = 'failed'; priorVersion = "$PriorVersion"; candidateVersion = $package.version; priorSha256 = $PriorSha256; installPath = $install; dataPath = $data; stages = $stages; scope = 'Inert preservation fixtures; no GUI launch, no real backup/restore or running-instance upgrade.' }
function Invoke-Installer([string] $File, [string] $Arguments, [string] $Stage) {
    $row = [ordered]@{ stage = $Stage; executableSha256 = (Get-FileHash -LiteralPath $File).Hash; status = 'failed' }
    $stages.Add($row)
    $process = Start-Process -FilePath $File -ArgumentList $Arguments -PassThru -WindowStyle Hidden
    try {
        if (!$process.WaitForExit(180000)) {
            $process.Kill($true)
            if (!$process.WaitForExit(5000)) { throw "Installer termination timeout: $Stage" }
            throw "Installer timeout: $Stage"
        }
        $row.exitCode = $process.ExitCode
        if ($process.ExitCode -notin @(0, 3010)) { throw "Installer failed ($($process.ExitCode)): $Stage" }
        $row.status = 'passed'
    } finally { $process.Dispose() }
}
function Assert-Installed([string] $Version, [string] $Hash) {
    $row = [ordered]@{ stage = 'installed-identity'; lifecycleStage = $(if ($stages.Count) { $stages[-1].stage }); status = 'failed'; version = "$Version"; expectedSha256 = $Hash; actualSha256 = $null; byteLength = $null; peVersion = $null; registryIdentity = @() }
    $stages.Add($row)
    $actualHash = (Get-FileHash -LiteralPath $exe -ErrorAction Stop).Hash
    $row.actualSha256 = $actualHash
    $row.byteLength = (Get-Item -LiteralPath $exe -ErrorAction Stop).Length
    $actual = [Diagnostics.FileVersionInfo]::GetVersionInfo($exe).ProductVersion
    $row.peVersion = $actual
    $found = @($registries | Where-Object { Test-Path -LiteralPath $_ })
    $row.registryIdentity = @($found | ForEach-Object {
        $identity = Get-ItemProperty -LiteralPath $_
        @{ registryPath = $_; DisplayVersion = $identity.DisplayVersion; InstallLocation = $identity.InstallLocation }
    })
    $evidence | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $out 'result.json') -ErrorAction Stop
    Assert-PeMachine $exe 0x8664
    Assert-InstallerVersion $actual $Version
    if ($found.Count -ne 1) { throw 'Expected exactly one Purgeon uninstall registration across registry views.' }
    $reg = Get-ItemProperty -LiteralPath $found[0]
    Assert-InstallerVersion $reg.DisplayVersion $Version
    if ($reg.InstallLocation.Trim('"').TrimEnd('\') -ine $install.TrimEnd('\')) { throw 'Uninstall registration differs from expected version/path.' }
    if ($Hash -and $actualHash -ne $Hash) { throw 'Installed candidate differs from portable executable hash.' }
    $row.status = 'passed'
}
$sentinels = [ordered]@{}
function Assert-Preserved {
    foreach ($file in $sentinels.Keys) {
        if (!(Test-Path -LiteralPath $file) -or (Get-FileHash -LiteralPath $file).Hash -ne $sentinels[$file]) { throw "Preservation failure: $file" }
    }
}
try {
    if (@($registries | Where-Object { Test-Path -LiteralPath $_ }).Count -or (Test-Path -LiteralPath $data) -or (Get-Process -Name purgeon -ErrorAction SilentlyContinue)) { throw 'Runner has pre-existing Purgeon state; refusing mutation.' }
    $tasks = @(
        @{ Path = '\Purgeon\'; Name = 'Start at Sign-in' }, @{ Path = '\Purgeon\'; Name = 'Weekly Maintenance' },
        @{ Path = '\SweepUninstall\'; Name = 'Start at Sign-in' }, @{ Path = '\SweepUninstall\'; Name = 'Weekly Maintenance' }
    )
    foreach ($task in $tasks) {
        if (Get-ScheduledTask -TaskPath $task.Path -TaskName $task.Name -ErrorAction SilentlyContinue) { throw 'Pre-existing owned task name; refusing mutation.' }
    }
    New-Item -ItemType Directory -Path $testRoot | Out-Null
    Invoke-Installer (Resolve-Path -LiteralPath $PriorInstaller).Path "/S /D=$install" 'install-prior'
    Assert-Installed $PriorVersion ''
    foreach ($relative in @('settings.json', 'snapshots/lifecycle-sentinel.json', 'backups/lifecycle-sentinel/manifest.json')) {
        $file = Join-Path $data $relative
        New-Item -ItemType Directory -Path (Split-Path $file) -Force | Out-Null
        '{"fixture":"purgeon-lifecycle-inert-v1","neverExecute":true}' | Set-Content -LiteralPath $file
        $sentinels[$file] = (Get-FileHash -LiteralPath $file).Hash
    }
    New-Item -ItemType Directory -Path $portable -Force | Out-Null
    $external = Join-Path $portable 'preserve.txt'
    'external portable data sentinel' | Set-Content -LiteralPath $external
    $sentinels[$external] = (Get-FileHash -LiteralPath $external).Hash
    $evidence.sentinels = $sentinels
    $candidate = (Resolve-Path -LiteralPath (Join-Path $Directory 'Purgeon-Setup-x64.exe')).Path
    Invoke-Installer $candidate "/S /D=$install" 'upgrade-candidate'
    Assert-Installed $package.version $package.portable.'Purgeon-Portable-x64.exe'
    Assert-Preserved
    if ($Reinstall) {
        Invoke-Installer $candidate "/S /D=$install" 'reinstall-candidate'
        Assert-Installed $package.version $package.portable.'Purgeon-Portable-x64.exe'
        Assert-Preserved
    }
    foreach ($repeat in 1..10) {
        & "$PSScriptRoot/test-packaged-cli.ps1" -Directory $Directory -Manifest $Manifest -Executable $exe -OutputDirectory (Join-Path $out "installed-cli-$repeat")
    }
    Assert-Preserved
    # These inert tasks never run: a future one-shot trigger plus a no-op action.
    $scheduler = New-Object -ComObject 'Schedule.Service'
    $scheduler.Connect()
    foreach ($folder in @('Purgeon', 'SweepUninstall')) {
        try { [void]$scheduler.GetFolder("\$folder") }
        catch { [void]$scheduler.GetFolder('\').CreateFolder($folder) }
    }
    foreach ($task in $tasks) {
        $action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\cmd.exe" -Argument '/d /c exit 0'
        $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddYears(1)
        Register-ScheduledTask -TaskPath $task.Path -TaskName $task.Name -Action $action -Trigger $trigger | Out-Null
        if (!(Get-ScheduledTask -TaskPath $task.Path -TaskName $task.Name -ErrorAction SilentlyContinue)) { throw 'Task fixture registration failed.' }
    }
    # NSIS _?= keeps uninstall synchronous and must be the final argument, unquoted.
    Invoke-Installer (Join-Path $install 'uninstall.exe') "/S _?=$install" 'uninstall-candidate'
    if ((Test-Path -LiteralPath $exe) -or @($registries | Where-Object { Test-Path -LiteralPath $_ }).Count) { throw 'Uninstall left executable or registration.' }
    foreach ($task in $tasks) {
        if (Get-ScheduledTask -TaskPath $task.Path -TaskName $task.Name -ErrorAction SilentlyContinue) { throw "Uninstall left owned task: $($task.Path)$($task.Name)" }
    }
    Assert-Preserved
    $evidence.status = 'passed'
} catch {
    $evidence.error = $_.Exception.Message
    $evidence.diagnosticErrors = [Collections.Generic.List[string]]::new()
    try {
        $diagnostics = (New-Item -ItemType Directory -Path (Join-Path $out 'diagnostics') -ErrorAction Stop).FullName
        $inputs = [ordered]@{
            'Purgeon-Setup-x64.exe' = (Join-Path $Directory 'Purgeon-Setup-x64.exe')
            'Purgeon-Portable-x64.zip' = (Join-Path $Directory 'Purgeon-Portable-x64.zip')
            'release-manifest.json' = $Manifest
            'installer.nsi' = (Join-Path $PSScriptRoot '../src-tauri/target/x86_64-pc-windows-msvc/release/nsis/x64/installer.nsi')
        }
        if ($stages | Where-Object { $_.stage -in @('upgrade-candidate', 'reinstall-candidate') }) { $inputs['installed-candidate.exe'] = $exe }
        foreach ($name in $inputs.Keys) {
            try {
                if (Test-Path -LiteralPath $inputs[$name] -PathType Leaf) {
                    $inputFile = Get-Item -LiteralPath $inputs[$name] -ErrorAction Stop
                    if ($inputFile.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Diagnostic input is a reparse point: $name" }
                    Copy-Item -LiteralPath $inputFile.FullName -Destination (Join-Path $diagnostics $name) -ErrorAction Stop
                } elseif ($name -ne 'installer.nsi') { throw "Diagnostic input missing: $name" }
            } catch { $evidence.diagnosticErrors.Add($_.Exception.Message) }
        }
    } catch { $evidence.diagnosticErrors.Add($_.Exception.Message) }
    throw
}
finally {
    try { $evidence | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $out 'result.json') -ErrorAction Stop }
    catch { if (!$evidence.error) { throw }; Write-Warning "Evidence write failed: $($_.Exception.Message); original failure: $($evidence.error)" }
    Write-Output "Installer lifecycle evidence: $out/result.json"
}
