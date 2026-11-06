$ErrorActionPreference='Stop'
$product='05c5845553866f521b6ae2cddfa3684f4f271a05'
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:GITHUB_REF_NAME -cne 'qualification/remove-av-handoff-check-05c5845-w4btyso') {
    throw 'This temporary workflow only runs on the qualification branch'
}
$repo=(Resolve-Path -LiteralPath "$PSScriptRoot/../../..").Path
function Assert-Source {
    $head=(& git -C $repo rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $head -cne $env:GITHUB_SHA) { throw 'Unexpected qualification checkout' }
    $parent=(& git -C $repo rev-parse 'HEAD^').Trim()
    if ($LASTEXITCODE -ne 0 -or $parent -cne $product) { throw 'Wrong exact product source' }
    $dirty=@(& git -C $repo status --porcelain=v1 --untracked-files=all)
    if ($LASTEXITCODE -ne 0 -or $dirty.Count) { throw 'Qualification source changed' }
}
Assert-Source
$allowed=@(
    '.github/qualification/remove-av-handoff-check/Assess-Hosted.cjs',
    '.github/qualification/remove-av-handoff-check/Collect-NativeCoverage.ps1',
    '.github/qualification/remove-av-handoff-check/Merge-Coverage.mjs',
    '.github/qualification/remove-av-handoff-check/workspace-wrapper.rs',
    '.github/workflows/qualify-remove-av-handoff-check.yml'
)
$changed=@(& git -C $repo diff --no-renames --name-status $product HEAD)
if ($LASTEXITCODE -ne 0 -or (Compare-Object @($allowed | ForEach-Object { "A`t$_" }) $changed)) { throw 'Qualification tree differs outside the approved additions' }
$hostTemp=(Resolve-Path -LiteralPath $env:RUNNER_TEMP).Path
$systemTemp=(Resolve-Path -LiteralPath ([IO.Path]::GetTempPath())).Path
$drive=[IO.DriveInfo]::new([IO.Path]::GetPathRoot($hostTemp))
$systemDrive=[IO.DriveInfo]::new([IO.Path]::GetPathRoot($systemTemp))
if ($drive.DriveFormat -ne 'NTFS' -or $systemDrive.DriveFormat -ne 'NTFS' -or [IO.Path]::GetPathRoot($repo) -ine $drive.Name) {
    throw 'Qualification checkout and both temp roots require local NTFS storage'
}
$maxGrowth=[int64](50GB)
$earlyGrowth=[int64](49.5GB)
$hardReserve=[int64](3GB)
$earlyFree=[int64](3.5GB)
$volumes=@([pscustomobject]@{role='workspace'; drive=$drive; startFreeBytes=[int64]$drive.AvailableFreeSpace})
if ($systemDrive.Name -ieq $drive.Name) {
    $volumes[0].role='workspace-and-native-temp'
} else {
    $volumes+=([pscustomobject]@{role='native-temp'; drive=$systemDrive; startFreeBytes=[int64]$systemDrive.AvailableFreeSpace})
}
if ($volumes[0].startFreeBytes -lt 12GB) { throw 'Cold workspace qualification requires at least 12 GiB free' }
if ($volumes.Count -gt 1 -and $volumes[1].startFreeBytes -le $earlyFree) { throw 'Native temp volume fails the per-volume reserve' }
$samples=[Collections.Generic.List[object]]::new()
$samples.Add([pscustomobject]@{phase='start'; measuredUtc=[DateTime]::UtcNow.ToString('o'); freeBytes=@($volumes.startFreeBytes); growthBytes=[int64]0})
$work=Join-Path $hostTemp 'remove-av-handoff-check-work'
$publish=Join-Path $hostTemp 'remove-av-handoff-check-public/evidence.json'
if ((Test-Path -LiteralPath $work) -or (Test-Path -LiteralPath (Split-Path $publish))) { throw 'Evidence destination must be new' }
$run=Join-Path $work 'native'
$nodeRun=Join-Path $work 'node'
$combined=Join-Path $work 'combined'
$candidate=Join-Path $work 'assessed-evidence.json'
New-Item -ItemType Directory -Path "$run/profiles","$work/temp","$work/tools" -Force | Out-Null
function Assert-Space([string]$Phase) {
    $free=@($volumes | ForEach-Object { [int64]$_.drive.AvailableFreeSpace })
    $growth=[int64]0
    for ($i=0; $i -lt $volumes.Count; $i++) {
        $growth+=[Math]::Max([int64]0,[int64]($volumes[$i].startFreeBytes-$free[$i]))
    }
    $samples.Add([pscustomobject]@{phase=$Phase; measuredUtc=[DateTime]::UtcNow.ToString('o'); freeBytes=$free; growthBytes=$growth})
    if (@($free | Where-Object {$_ -le $earlyFree}).Count -gt 0 -or $growth -ge $earlyGrowth) {
        throw "Qualification disk stop during $Phase; per-volume reserve or aggregate growth threshold reached"
    }
}
function Show-Space([string]$Phase) {
    $summary=@(for ($i=0; $i -lt $volumes.Count; $i++) {
        $minimum=($samples | ForEach-Object {$_.freeBytes[$i]} | Measure-Object -Minimum).Minimum
        [pscustomobject]@{role=$volumes[$i].role; startFreeBytes=$volumes[$i].startFreeBytes; minFreeBytes=$minimum}
    })
    $peak=($samples | Measure-Object -Property growthBytes -Maximum).Maximum
    $row=[pscustomobject]@{phase=$Phase; volumes=$summary; peakGrowthBytes=$peak; earlyGrowthBytes=$earlyGrowth; earlyFreeBytes=$earlyFree; samples=$samples.Count}
    Write-Host ('Qualification disk '+($row | ConvertTo-Json -Depth 4 -Compress))
}
function New-ProbedNativeTemp {
    $path=Join-Path $systemTemp ('purgeon-qualify-native-'+[guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $path | Out-Null
    $fixture=Join-Path $path ('purgeon-recovery-short-probe-'+[guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $fixture | Out-Null
    try {
        Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class PurgeonQualificationTempProbe {
    [DllImport("kernel32.dll", EntryPoint="GetShortPathNameW", ExactSpelling=true, CharSet=CharSet.Unicode)]
    public static extern uint GetShortPathName(string path, StringBuilder shortPath, uint capacity);
}
"@
        $short=[Text.StringBuilder]::new(32768)
        $length=[PurgeonQualificationTempProbe]::GetShortPathName($fixture,$short,[uint32]$short.Capacity)
        if ($length -eq 0 -or $length -ge $short.Capacity -or $short.ToString() -ieq $fixture) {
            throw 'Native temp did not provide the distinct 8.3 alias required by the unchanged tests'
        }
        Write-Host 'Qualification native temp distinct 8.3 alias verified'
    } finally {
        [IO.Directory]::Delete($fixture)
    }
    return $path
}
function Invoke-Guarded([string]$Phase,[string]$File,[string[]]$Argv,[string]$WorkingDirectory,[string]$Stdout,[string]$Stderr,[int]$TimeoutSeconds) {
    Assert-Space "$Phase-before"
    Write-Host "Qualification phase=$Phase status=started timeoutSeconds=$TimeoutSeconds"
    $start = [Diagnostics.ProcessStartInfo]::new($File)
    $start.WorkingDirectory = $WorkingDirectory
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($a in $Argv) { $start.ArgumentList.Add($a) }
    $proc = [Diagnostics.Process]::new()
    $proc.StartInfo = $start
    $out = $null
    $err = $null
    $started = $false
    try {
        $out = [IO.FileStream]::new($Stdout,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
        $err = [IO.FileStream]::new($Stderr,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
        if (!$proc.Start()) { throw "Unable to start owned process for $Phase" }
        $started = $true
        $outTask = $proc.StandardOutput.BaseStream.CopyToAsync($out)
        $errTask = $proc.StandardError.BaseStream.CopyToAsync($err)
        $timer = [Diagnostics.Stopwatch]::StartNew()
        while (!$proc.WaitForExit(1000)) {
            Assert-Space $Phase
            if ($timer.Elapsed.TotalSeconds -ge $TimeoutSeconds) { throw "Owned $Phase reached its deadline" }
        }
        if (![Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($outTask,$errTask),10000)) {
            throw "Owned $Phase output drain was not confirmed"
        }
        Assert-Space "$Phase-after"
        Write-Host "Qualification phase=$Phase status=completed exitCode=$($proc.ExitCode) elapsedSeconds=$([int]$timer.Elapsed.TotalSeconds)"
        Show-Space $Phase
        return $proc.ExitCode
    } finally {
        if ($started -and !$proc.HasExited) {
            $proc.Kill($true)
            if (!$proc.WaitForExit(10000)) { throw "Owned $Phase termination was not confirmed" }
        }
        $proc.Dispose()
        if ($out) { $out.Dispose() }
        if ($err) { $err.Dispose() }
    }
}
function Write-DiskSamples([string]$Path) {
    [pscustomobject]@{
        volumes=@($volumes | Select-Object role,startFreeBytes)
        maxGrowthBytes=$maxGrowth
        earlyGrowthBytes=$earlyGrowth
        hardReserveBytes=$hardReserve
        earlyFreeBytes=$earlyFree
        intervalMilliseconds=1000
        nativeTemp83Verified=$nativeTemp83Verified
        samples=$samples.ToArray()
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $Path
}
function Snapshot {
    $paths=@(& git -C $repo ls-files src-tauri)
    if ($LASTEXITCODE -ne 0) { throw 'Native source enumeration failed' }
    @($paths | Sort-Object -Unique | Where-Object { $_ -match '\.(rs|toml|lock|json)$' } | ForEach-Object {
        [pscustomobject]@{path=$_;sha256=(Get-FileHash -LiteralPath (Join-Path $repo $_) -Algorithm SHA256).Hash}
    })
}
Assert-Space 'preflight'
Show-Space 'preflight'
$nativeTemp83Verified=$false
try {
    $nativeTemp=New-ProbedNativeTemp
    $nativeTemp83Verified=$true
    Assert-Space 'native-temp-probe'
    $toolchain='1.99.0-x86_64-pc-windows-msvc'
    $compiler=(& rustup which --toolchain $toolchain rustc).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Pinned rustc unavailable' }
    $cargo=(& rustup which --toolchain $toolchain cargo).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Pinned cargo unavailable' }
    $tc=Split-Path (Split-Path $compiler -Parent) -Parent
    $llvm="$tc/lib/rustlib/x86_64-pc-windows-msvc/bin"
    $node=(Get-Command node.exe -ErrorAction Stop).Source
    $npmCli=Join-Path (Split-Path $node -Parent) 'node_modules/npm/bin/npm-cli.js'
    foreach($file in @($compiler,$cargo,$node,$npmCli,"$llvm/llvm-cov.exe","$llvm/llvm-profdata.exe")) {
        if (!(Test-Path -LiteralPath $file -PathType Leaf)) { throw 'Pinned build or coverage tool unavailable' }
    }
    $rv=@(& $compiler -Vv)
    if ($LASTEXITCODE -ne 0 -or 'release: 1.99.0' -cnotin $rv -or 'LLVM version: 23.1.1' -cnotin $rv -or 'host: x86_64-pc-windows-msvc' -cnotin $rv) { throw 'Unexpected compiler or LLVM toolchain' }
    if ((& $node --version) -cne 'v26.13.0' -or $LASTEXITCODE -ne 0) { throw 'Unexpected Node toolchain' }
    $rv | Set-Content -LiteralPath "$run/compiler.txt"
    & "$llvm/llvm-cov.exe" --version > "$run/llvm.txt"
    if ($LASTEXITCODE -ne 0) { throw 'LLVM version check failed' }

    $vswhere=Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
    $vs=(& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | Select-Object -First 1)
    if ($LASTEXITCODE -ne 0 -or !$vs) { throw 'Verified MSVC installation unavailable' }
    & "$vs/Common7/Tools/Launch-VsDevShell.ps1" -Arch amd64 -HostArch amd64 -SkipAutomaticLocation | Out-Null
    $sdk=Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10'
    if (!(Test-Path -LiteralPath "$sdk/Lib/10.0.26100.0/ucrt/x64/ucrt.lib")) { throw 'Expected UCRT SDK 10.0.26100.0 missing' }
    $env:LIB="$sdk/Lib/10.0.26100.0/ucrt/x64;$env:LIB"
    $env:INCLUDE="$sdk/Include/10.0.26100.0/ucrt;$env:INCLUDE"

    $env:TEMP="$work/temp"; $env:TMP="$work/temp"
    $env:CARGO_HOME="$work/cargo-home"
    $env:CARGO_TARGET_DIR="$work/target"
    $env:CARGO_INCREMENTAL='0'
    $env:CARGO_TERM_COLOR='never'
    $env:RUST_TEST_THREADS='1'
    $env:npm_config_cache="$work/npm-cache"
    $env:RUSTC=$compiler
    $env:RUSTC_WRAPPER=$null
    $env:RUSTC_WORKSPACE_WRAPPER=$null
    $env:RUSTFLAGS=$null
    $env:CARGO_ENCODED_RUSTFLAGS=$null

    $code=Invoke-Guarded 'npm-ci' $node @($npmCli,'ci') $repo "$work/npm-ci.stdout" "$work/npm-ci.stderr" 300
    if ($code -ne 0) { throw "npm ci failed: $code" }
    $vite=(Get-Content -LiteralPath "$repo/node_modules/vite/package.json" -Raw | ConvertFrom-Json).version
    if ($vite -cne '8.3.5') { throw 'Vite version differs from approved workload' }
    $code=Invoke-Guarded 'frontend-build' $node @($npmCli,'run','build') $repo "$work/frontend-build.stdout" "$work/frontend-build.stderr" 300
    if ($code -ne 0) { throw "Frontend build failed: $code" }
    $nodeCollector=Invoke-Guarded 'node-coverage' $node @("$repo/scripts/collect-node-coverage.mjs",$nodeRun) $repo "$work/node-coverage.stdout" "$work/node-coverage.stderr" 480
    if ($nodeCollector -notin 0,1,2 -or !(Test-Path -LiteralPath "$nodeRun/execution.json")) { throw 'Node coverage did not produce test evidence' }
    $nodeExecution=Get-Content -LiteralPath "$nodeRun/execution.json" -Raw | ConvertFrom-Json
    if ($nodeExecution.exitCode -ne 0 -or $null -eq $nodeExecution.exitCode -or $nodeExecution.signal) { throw 'Instrumented Node tests failed' }

    $wrapperSource="$work/tools/workspace-wrapper.rs"
    $wrapper="$work/tools/workspace-wrapper.exe"
    $lf=(Get-Content -LiteralPath "$PSScriptRoot/workspace-wrapper.rs" -Raw).Replace("`r`n","`n")
    [IO.File]::WriteAllText($wrapperSource,$lf)
    $sourceHash=(Get-FileHash -LiteralPath $wrapperSource -Algorithm SHA256).Hash
    if ($sourceHash -ine '7c93b293259459115f2ad84c8ed70628305f597672dcd83354e8863201ef7d28') { throw 'Wrapper source differs from reviewed LF-normalized source' }
    $code=Invoke-Guarded 'workspace-wrapper' $compiler @('--edition=2021',$wrapperSource,'-o',$wrapper) $repo "$work/wrapper.stdout" "$work/wrapper.stderr" 120
    if ($code -ne 0) { throw "Workspace wrapper compile failed: $code" }

    # Fetch only the lockfile graph here, then execute the same offline test workload.
    $code=Invoke-Guarded 'cargo-fetch' $cargo @('fetch','--locked','--target','x86_64-pc-windows-msvc') "$repo/src-tauri" "$work/cargo-fetch.stdout" "$work/cargo-fetch.stderr" 420
    if ($code -ne 0) { throw "Locked cargo fetch failed: $code" }
    Assert-Source
    $before=Snapshot
    $before | ConvertTo-Json | Set-Content -LiteralPath "$run/source-before.json"
    $env:RUSTC_WORKSPACE_WRAPPER=$wrapper
    $env:PURGEON_COVERAGE_RUSTC=$compiler
    $env:PURGEON_COVERAGE_MANIFEST_DIR="$repo/src-tauri"
    $env:RUSTFLAGS='-Cinstrument-coverage'
    $env:LLVM_PROFILE_FILE="$run/profiles/%p-%m.profraw"
    Get-FileHash -LiteralPath $compiler,$cargo,"$llvm/llvm-cov.exe","$llvm/llvm-profdata.exe",$wrapper,$wrapperSource,$PSCommandPath |
        Select-Object Path,Hash | ConvertTo-Json | Set-Content -LiteralPath "$run/tool-inputs.json"
    $previousTemp=$env:TEMP
    $previousTmp=$env:TMP
    try {
        $env:TEMP=$nativeTemp
        $env:TMP=$nativeTemp
        $test=Invoke-Guarded 'native-tests' $cargo @('test','--locked','--offline','--all-targets','--target','x86_64-pc-windows-msvc','--message-format=json','--jobs','1') "$repo/src-tauri" "$run/cargo.jsonl" "$run/cargo.stderr.log" 1320
    } finally {
        $env:TEMP=$previousTemp
        $env:TMP=$previousTmp
    }
    if ($test -ne 0) {
        & $node "$PSScriptRoot/Assess-Hosted.cjs" --diagnose-cargo "$run/cargo.jsonl" "$run/cargo.stderr.log"
        throw "Instrumented native tests failed: $test"
    }
    $after=Snapshot
    $after | ConvertTo-Json | Set-Content -LiteralPath "$run/source-after.json"
    if (Compare-Object ($before | ForEach-Object {"$($_.path):$($_.sha256)"}) ($after | ForEach-Object {"$($_.path):$($_.sha256)"})) { throw 'Native source changed during coverage' }
    $nativeExport=Invoke-Guarded 'native-export' $node @("$repo/scripts/collect-native-coverage.mjs",$run,$llvm,"$run/export") $repo "$run/export.stdout.log" "$run/export.stderr.log" 360
    if ($nativeExport -ne 0) { throw "Native export failed: $nativeExport" }
    [pscustomobject]@{testExitCode=$test;exportExitCode=$nativeExport;sourceUnchanged=$true;sourceCommit=$product} |
        ConvertTo-Json | Set-Content -LiteralPath "$run/result.json"
    Assert-Source
    $merge=Invoke-Guarded 'merge-coverage' $node @("$PSScriptRoot/Merge-Coverage.mjs","$nodeRun/manifest.json","$nodeRun/evidence.json",$run,$combined,"$llvm/llvm-cov.exe") $repo "$work/merge.stdout" "$work/merge.stderr" 360
    if ($merge -notin 0,1) { throw "Combined measurement was incomplete: $merge" }
    Assert-Source
    Assert-Space 'before-assessment'
    Write-DiskSamples "$run/disk-samples.json"
    $assessment=Invoke-Guarded 'assessment' $node @("$PSScriptRoot/Assess-Hosted.cjs",$combined,$nodeRun,$run,$candidate) $repo "$work/assessment.stdout" "$work/assessment.stderr" 180
    if ($assessment -notin 0,1 -or !(Test-Path -LiteralPath $candidate -PathType Leaf)) {
        & $node "$PSScriptRoot/Assess-Hosted.cjs" --diagnose-assessment "$work/assessment.stderr"
        throw "Manual coverage assessment was incomplete: $assessment"
    }
    Assert-Source
    Assert-Space 'post-assessment'
    Write-DiskSamples "$run/final-disk-samples.json"
    # The candidate remains private until the postflight budget and payload
    # have passed validation. Finalization only reads two bounded JSON files.
    & $node "$PSScriptRoot/Assess-Hosted.cjs" --finalize-disk $candidate "$run/final-disk-samples.json" $publish
    if ($LASTEXITCODE -ne 0) { throw 'Sanitized qualification evidence could not be promoted' }
    if ($assessment -ne 0) { throw "Manual coverage assessment did not pass: $assessment" }
} finally {
    Show-Space 'final'
    Write-DiskSamples "$run/last-disk-samples.json"
}
