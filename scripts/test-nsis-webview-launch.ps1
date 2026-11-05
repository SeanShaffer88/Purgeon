param([string] $OutputDirectory = (Join-Path $PWD 'verification/nsis-contract'))
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'NSIS runtime fixtures are restricted to disposable GitHub-hosted runners.'
}
function New-ContractFixture([string] $Contract, [string] $Child, [int] $ChildExit, [string] $Case) {
    $body = @'
Unicode true
RequestExecutionLevel user
SilentInstall silent
!include LogicLib.nsh
!include FileFunc.nsh
OutFile "fixture.exe"
LangString webview2InstallError 1033 "child launch failed"
LangString webview2AbortError 1033 "child launch aborted"
@CONTRACT@
Var PassiveMode
Function .onInit
  @PASSIVE@
  StrCmp $PassiveMode @PASSIVE_EXPECTED@ +2
    Abort "passive mode mismatch"
  @INVALID_STDOUT@
  StrCpy $0 "register-zero"
  StrCpy $1 "register-one"
  StrCpy $2 "register-two"
  StrCpy $3 "register-three"
  StrCpy $4 "register-four"
  StrCpy $5 "register-five"
  Push "stack-sentinel"
  SetErrorLevel 73
  SetErrors
  !insertmacro PurgeonTrace "fixture.error"
  IfErrors +2
    Abort "lost error flag"
  ClearErrors
  !insertmacro PurgeonTrace "fixture.clear"
  IfErrors 0 +2
    Abort "introduced error flag"
  StrCmp $0 "register-zero" +2
    Abort "clobbered zero"
  StrCmp $1 "register-one" +2
    Abort "clobbered one"
  StrCmp $2 "register-two" +2
    Abort "clobbered two"
  StrCmp $3 "register-three" +2
    Abort "clobbered three"
  StrCmp $4 "register-four" +2
    Abort "clobbered four"
  StrCmp $5 "register-five" +2
    Abort "clobbered five"
  Pop $9
  StrCmp $9 "stack-sentinel" +2
    Abort "clobbered stack"
  GetErrorLevel $9
  StrCmp $9 73 +2
    Abort "clobbered exit state"
  SetErrorLevel 0
FunctionEnd
Section
  !insertmacro PurgeonExecWait '"@CHILD@" /d /c exit @EXIT@' $1
  !insertmacro PurgeonTrace "fixture.exit.consumed"
  ${If} $1 != 0
    Abort "nonzero child rejected"
  ${EndIf}
SectionEnd
'@
    return $body.Replace('@CONTRACT@', $Contract).Replace('@CHILD@', $Child).Replace('@EXIT@', "$ChildExit").Replace('@PASSIVE@', $script:passiveBlock).Replace('@PASSIVE_EXPECTED@', $(if ($Case -like 'flag-passive*') { '1' } else { '""' })).Replace('@INVALID_STDOUT@', $(if ($Case.EndsWith('invalid-stdout')) { "System::Call 'kernel32::SetStdHandle(i -11, p 0)'" } else { '' }))
}
if (Test-Path -LiteralPath $OutputDirectory) { throw 'Fixture evidence directory must be new.' }
$out = (New-Item -ItemType Directory -Path $OutputDirectory).FullName
$root = Join-Path $env:RUNNER_TEMP ('purgeon nsis contract ' + [guid]::NewGuid().ToString('N'))
if (Test-Path -LiteralPath $root) { throw 'Fixture root already exists.' }
$compiler = Join-Path $env:LOCALAPPDATA 'tauri/NSIS/makensis.exe'
if (!(Test-Path -LiteralPath $compiler -PathType Leaf)) { throw "Required existing NSIS compiler missing: $compiler" }
$sourcePath = Join-Path $PSScriptRoot '../src-tauri/windows/installer.nsi'
$source = Get-Content -LiteralPath $sourcePath -Raw
$blocks = [regex]::Matches($source, '(?s); PURGEON_CONTRACT_BEGIN\r?\n.*?; PURGEON_CONTRACT_END')
if ($blocks.Count -ne 1) { throw 'Production contract must have exactly one unambiguous block.' }
$contract = $blocks[0].Value
$script:passiveBlock = [regex]::Match($source, '(?s)  \$\{GetOptions\} \$CMDLINE "/P" \$PassiveMode\r?\n.*?  \$\{EndIf\}').Value
if (!$script:passiveBlock) { throw 'Production passive block missing.' }
$childrenConfirmed = $true
$report = [ordered]@{ status = 'failed'; sourceSha256 = (Get-FileHash -LiteralPath $sourcePath).Hash; compilerSha256 = (Get-FileHash -LiteralPath $compiler).Hash; contractSha256 = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($contract))); passiveBlockSha256 = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($script:passiveBlock))); cases = @(); negativeControl = 'NotPerformed: original-source runtime comparison deferred' }
try {
    New-Item -ItemType Directory -Path (Join-Path $root 'child with spaces') | Out-Null
    $child = Join-Path $root 'child with spaces/cmd.exe'
    Copy-Item -LiteralPath (Join-Path $env:SystemRoot 'System32/cmd.exe') -Destination $child
    $report.childSha256 = (Get-FileHash -LiteralPath $child).Hash
    foreach ($case in @('success', 'missing', 'nonzero', 'disabled', 'invalid-stdout', 'missing-disabled', 'missing-invalid-stdout', 'nonzero-disabled', 'nonzero-invalid-stdout', 'flag-alone', 'flag-passive-first', 'flag-passive-last', 'flag-silent', 'flag-update', 'flag-noshortcut')) {
        $caseRoot = (New-Item -ItemType Directory -Path (Join-Path $root $case)).FullName
        $text = New-ContractFixture $contract $(if ($case -like 'missing*') { Join-Path $caseRoot 'missing child.exe' } else { $child }) $(if ($case -like 'nonzero*') { 7 } else { 0 }) $case
        $inputPath = Join-Path $caseRoot 'fixture.nsi'
        $text | Set-Content -LiteralPath $inputPath -Encoding utf8
        # Copied cmd.exe and generated executable never enter the artifact directory.
        $text.Replace($root, '<owned-runner-root>') | Set-Content -LiteralPath (Join-Path $out "$case.nsi")
        $row = [ordered]@{ case = $case; compileExit = $null; compileStatus = 'started'; status = 'failed' }
        $report.cases += $row
        $compileProcess = Start-Process -FilePath $compiler -ArgumentList @('/WX', ('"' + $inputPath + '"')) -RedirectStandardOutput (Join-Path $out "$case.compile.log") -RedirectStandardError (Join-Path $out "$case.compile.stderr.log") -PassThru -WindowStyle Hidden
        $childrenConfirmed = $false
        try {
            if (!$compileProcess.WaitForExit(60000)) {
                $row.compileStatus = 'timeout'
                $compileProcess.Kill($true)
                $childrenConfirmed = $compileProcess.WaitForExit(5000)
                throw "Fixture compiler timed out: $case"
            }
            $childrenConfirmed = $true
            $row.compileExit = $compileProcess.ExitCode
            $row.compileStatus = 'exited'
        } finally { $compileProcess.Dispose() }
        if ($row.compileExit) { throw "Fixture compile failed ($($row.compileExit)): $case" }
        $stdout = Join-Path $out "$case.stdout.jsonl"
        $stderr = Join-Path $out "$case.stderr.log"
        $arguments = if ($case.EndsWith('disabled')) { '/S' } else { '/S /LOGPURGEON' }
        switch ($case) {
            'flag-alone' { $arguments = '/LOGPURGEON' }
            'flag-passive-first' { $arguments = '/P /LOGPURGEON' }
            'flag-passive-last' { $arguments = '/LOGPURGEON /P' }
            'flag-silent' { $arguments = '/LOGPURGEON /S' }
            'flag-update' { $arguments = '/LOGPURGEON /UPDATE' }
            'flag-noshortcut' { $arguments = '/LOGPURGEON /NS' }
        }
        $binary = Join-Path $caseRoot 'fixture.exe'
        $row.fixtureSha256 = (Get-FileHash -LiteralPath $binary).Hash
        $process = Start-Process -FilePath $binary -ArgumentList $arguments -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru -WindowStyle Hidden
        $childrenConfirmed = $false
        try {
            if (!$process.WaitForExit(30000)) {
                $process.Kill($true)
                $childrenConfirmed = $process.WaitForExit(5000)
                if (!$childrenConfirmed) { throw 'Fixture termination timed out.' }
                throw "Fixture timed out: $case"
            }
            $childrenConfirmed = $true
            $row.exitCode = $process.ExitCode
        } finally { $process.Dispose() }
        $expected = if ($case -match '^(missing|nonzero)') { 2 } else { 0 }
        if ($row.exitCode -ne $expected) { throw "Unexpected fixture exit $($row.exitCode), expected $expected : $case" }
        $trace = @(Get-Content -LiteralPath $stdout | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json })
        if ($case.EndsWith('disabled') -or $case.EndsWith('invalid-stdout')) {
            if ($trace.Count) { throw 'Disabled or unwritable logging emitted trace.' }
        } else {
            if ($trace.Count -lt 2 -or $trace[0].event -ne 'fixture.error' -or $trace[1].event -ne 'fixture.clear') { throw 'Trace state contract failed.' }
            for ($i = 0; $i -lt $trace.Count; $i++) {
                $record = $trace[$i]
                if ((($record.PSObject.Properties.Name | Sort-Object) -join ',') -ne 'event,nativeError,operation,phase,result,schemaVersion,sequence' -or $record.schemaVersion -ne 1 -or $record.sequence -ne ($i + 1) -or $null -ne $record.nativeError) { throw 'Invalid trace schema or sequence.' }
            }
            $launch = @($trace | Where-Object operation -eq 'ExecWait')
            if ($launch.Count -ne 1) { throw 'Expected one launch record.' }
            if ($case -like 'missing*') {
                if ($null -ne $launch[0].result) { throw 'Launch error invented child exit.' }
            } elseif ($launch[0].result -ne $(if ($case -like 'nonzero*') { 7 } else { 0 })) { throw 'Actual child exit missing.' }
            if ($case -like 'missing*'  -and ('fixture.exit.consumed' -in $trace.event -or 'webview.launch.failed' -notin $trace.event)) { throw 'Undefined child exit was consumed or launch failure was unreported.' }
            if ($case -like 'nonzero*' -and 'fixture.exit.consumed' -notin $trace.event) { throw 'Nonzero child never returned through shared wrapper.' }
        }
        $row.status = 'passed'
    }
    $report.status = 'passed'
} catch {
    $report.error = $_.Exception.Message
    throw
} finally {
    $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $out 'result.json')
    $absolute = [IO.Path]::GetFullPath($root)
    $parent = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\') + '\'
    if (!$absolute.StartsWith($parent, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe fixture cleanup root.' }
    if (!$childrenConfirmed) { throw 'Cleanup refused: child termination unconfirmed.' }
    if (Test-Path -LiteralPath $absolute) {
        if ((Get-Item -LiteralPath $absolute -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing reparse cleanup root.' }
        $pending = [Collections.Generic.Queue[string]]::new()
        $pending.Enqueue($absolute)
        while ($pending.Count) {
            foreach ($entry in Get-ChildItem -LiteralPath $pending.Dequeue() -Force) {
                if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing cleanup through reparse points.' }
                if ($entry.PSIsContainer) { $pending.Enqueue($entry.FullName) }
            }
        }
        Remove-Item -LiteralPath $absolute -Recurse -Force
    }
}
