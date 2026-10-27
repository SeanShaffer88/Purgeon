# Compile the real dispatcher with harmless child programs. Only its elevation
# request changes for this probe; production installers are tested separately in CI.
. "$PSScriptRoot/windows-package-tools.ps1"
$root = Split-Path $PSScriptRoot -Parent
$testDir = Join-Path $root ('out/setup-probe-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testDir | Out-Null
$compiler = Get-NsisCompiler
$resultPath = Join-Path $testDir 'result.txt'
$stubPath = Join-Path $testDir 'child.nsi'
@'
Unicode true
Name "Purgeon harmless installer probe"
OutFile "${OUTPUT}"
RequestExecutionLevel user
Function .onInit
  FileOpen $0 "${RESULT}" w
  FileWrite $0 "${ARCH}|$INSTDIR|$CMDLINE"
  FileClose $0
  SetErrorLevel 42
  Quit
FunctionEnd
Section
SectionEnd
'@ | Set-Content -LiteralPath $stubPath
foreach ($arch in @('x86', 'x64')) {
    $output = Join-Path $testDir "$arch.exe"
    & $compiler /V1 "/DOUTPUT=$output" "/DRESULT=$resultPath" "/DARCH=$arch" $stubPath
    if ($LASTEXITCODE) { throw 'Probe child compilation failed.' }
}
$source = Get-Content -LiteralPath "$root/src-tauri/windows/universal-setup.nsi" -Raw
if ([regex]::Matches($source, 'RequestExecutionLevel admin').Count -ne 1) {
    throw 'Unexpected production privilege declaration.'
}
$source.Replace('RequestExecutionLevel admin', 'RequestExecutionLevel user') |
    Set-Content -LiteralPath "$testDir/wrapper.nsi"
$wrapper = Join-Path $testDir 'wrapper.exe'
$x86 = Join-Path $testDir 'x86.exe'
$x64 = Join-Path $testDir 'x64.exe'
& $compiler /V1 "/DOUTPUT=$wrapper" "/DSETUP_X86=$x86" "/DSETUP_X64=$x64" `
    /DVERSION=0.7.0 "/DICON=$root/src-tauri/icons/icon.ico" "$testDir/wrapper.nsi"
if ($LASTEXITCODE) { throw 'Probe dispatcher compilation failed.' }
$installDir = Join-Path $testDir 'install with spaces'
$expectedArch = if ([Environment]::Is64BitOperatingSystem) { 'x64' } else { 'x86' }
foreach ($arguments in @('/S /MARK="has spaces"', "/S /MARK=`"has spaces`" /D=$installDir", '/MARK="has spaces"')) {
    if (Test-Path -LiteralPath $resultPath) { Remove-Item -LiteralPath $resultPath }
    $process = Start-Process -FilePath $wrapper -ArgumentList $arguments -PassThru -WindowStyle Hidden
    if (-not $process.WaitForExit(10000)) {
        Stop-Process -Id $process.Id -Force
        throw 'Dispatcher probe timed out.'
    }
    $result = Get-Content -LiteralPath $resultPath -Raw
    if ($process.ExitCode -ne 42 -or -not $result.StartsWith("$expectedArch|") -or
        $result -notmatch '/MARK="has spaces"') { throw "Dispatcher failed: $result" }
    $expectedDir = if ($arguments.Contains('/D=')) { $installDir } else { '' }
    if (-not $result.StartsWith("$expectedArch|$expectedDir|")) { throw 'Installation directory was altered.' }
    if ($arguments.StartsWith('/S') -and $result -notmatch '/S ') { throw 'Silent switch was lost.' }
}
Write-Output 'Passed 3 dispatcher probes: architecture, child failure code, quoted arguments, silent mode and explicit/default paths.'
