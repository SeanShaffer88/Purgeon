param([Parameter(Mandatory)][string] $Directory)
. "$PSScriptRoot/windows-package-tools.ps1"
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'Installer smoke tests are restricted to disposable GitHub-hosted runners.'
}
$packages = (Resolve-Path -LiteralPath $Directory).Path
$testRoot = Join-Path $env:RUNNER_TEMP ('purgeon-installer-tests-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testRoot | Out-Null

function Invoke-Installer([string] $File, [string] $Arguments) {
    $process = Start-Process -FilePath $File -ArgumentList $Arguments -PassThru -WindowStyle Hidden
    if (-not $process.WaitForExit(180000)) {
        Stop-Process -Id $process.Id -Force
        throw "Installer timed out: $File"
    }
    if ($process.ExitCode -notin @(0, 3010)) {
        Get-ChildItem -LiteralPath $testRoot -Filter '*.log' | ForEach-Object {
            Get-Content -LiteralPath $_.FullName -Tail 40
        }
        throw "Installer failed ($($process.ExitCode)): $File"
    }
}

# /S must install silently, /D must preserve spaces, and the setup must install the native x64 build.
$exeInstall = Join-Path $testRoot 'EXE install'
Invoke-Installer "$packages/Purgeon-Setup-x64.exe" "/S /D=$exeInstall"
Assert-PeMachine "$exeInstall/purgeon.exe" 0x8664
$uninstaller = Join-Path $exeInstall 'uninstall.exe'
if (-not (Test-Path -LiteralPath $uninstaller)) { throw 'NSIS uninstaller missing.' }
Invoke-Installer $uninstaller '/S'
$deadline = (Get-Date).AddSeconds(30)
while ((Test-Path -LiteralPath "$exeInstall/purgeon.exe") -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 250
}
if (Test-Path -LiteralPath "$exeInstall/purgeon.exe") { throw 'EXE uninstall left the executable behind.' }
Write-Output 'Verified native x64 EXE silent install/uninstall and paths with spaces.'
