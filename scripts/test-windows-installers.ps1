param([Parameter(Mandatory)][string] $Directory)
. "$PSScriptRoot/windows-package-tools.ps1"
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'Installer smoke tests are restricted to disposable GitHub-hosted runners.'
}
$packages = (Resolve-Path -LiteralPath $Directory).Path
$testRoot = Join-Path $env:RUNNER_TEMP ([Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testRoot | Out-Null

function Invoke-Installer([string] $File, [string] $Arguments) {
    $process = Start-Process -FilePath $File -ArgumentList $Arguments -PassThru -WindowStyle Hidden
    if (-not $process.WaitForExit(180000)) {
        Stop-Process -Id $process.Id -Force
        throw "Installer timed out: $File"
    }
    if ($process.ExitCode -notin @(0, 3010)) { throw "Installer failed ($($process.ExitCode)): $File" }
}

# An x86 MSI on the x64 runner must install the x86 executable successfully.
$msiPath = "$packages/Purgeon-Setup.msi"
$msiInstall = Join-Path $testRoot 'MSI install'
Invoke-Installer msiexec.exe "/i `"$msiPath`" /qn /norestart INSTALLDIR=`"$msiInstall`" /L*v `"$testRoot/msi-install.log`""
Assert-PeMachine "$msiInstall/purgeon.exe" 0x14C
$tasks = @('\Purgeon\Start at Sign-in', '\Purgeon\Weekly Maintenance',
           '\SweepUninstall\Start at Sign-in', '\SweepUninstall\Weekly Maintenance')
foreach ($task in $tasks) {
    & schtasks.exe /Create /TN $task /SC ONSTART /TR 'cmd.exe /c exit 0' /F
    if ($LASTEXITCODE) { throw "Cannot create harmless task fixture: $task" }
}
Invoke-Installer msiexec.exe "/x `"$msiPath`" /qn /norestart /L*v `"$testRoot/msi-uninstall.log`""
if (Test-Path -LiteralPath "$msiInstall/purgeon.exe") { throw 'MSI uninstall left the executable behind.' }
foreach ($task in $tasks) {
    & schtasks.exe /Query /TN $task 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { throw "MSI uninstall left scheduled task: $task" }
}

# /S must reach the child, /D must preserve spaces, and native selection must pick x64.
$exeInstall = Join-Path $testRoot 'EXE install'
Invoke-Installer "$packages/Purgeon-Setup.exe" "/S /D=$exeInstall"
Assert-PeMachine "$exeInstall/purgeon.exe" 0x8664
$uninstaller = Join-Path $exeInstall 'uninstall.exe'
if (-not (Test-Path -LiteralPath $uninstaller)) { throw 'NSIS uninstaller missing.' }
Invoke-Installer $uninstaller '/S'
$deadline = (Get-Date).AddSeconds(30)
while ((Test-Path -LiteralPath "$exeInstall/purgeon.exe") -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 250
}
if (Test-Path -LiteralPath "$exeInstall/purgeon.exe") { throw 'EXE uninstall left the executable behind.' }
Write-Output 'Verified x86 MSI and native x64 EXE silent install/uninstall, paths with spaces, and MSI task cleanup.'
