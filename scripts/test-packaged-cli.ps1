param(
    [Parameter(Mandatory)][string] $Directory,
    [Parameter(Mandatory)][string] $Manifest,
    [string] $EvidenceDirectory,
    [string] $Executable,
    [string] $OutputDirectory = (Join-Path $PWD 'verification/packaged-cli'),
    [ValidateRange(1,120)][int] $TimeoutSeconds = 45
)
$ErrorActionPreference = 'Stop'
function Get-QuiescentInventory {
    param(
        [Parameter(Mandatory)][scriptblock] $Snapshot,
        [Parameter(Mandatory)][AllowEmptyCollection()][Collections.Generic.List[object]] $Evidence,
        [ValidateRange(1,10000)][int] $DeadlineMilliseconds = 10000,
        [scriptblock] $Wait = { param($milliseconds) [void][Threading.Tasks.Task]::Delay($milliseconds).GetAwaiter().GetResult() }
    )
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $attempt = 0
    while ($true) {
        $attempt++
        try {
            $snapshotResult = @(& $Snapshot)
            $Evidence.Add([ordered]@{ attempt = $attempt; elapsedMs = $timer.ElapsedMilliseconds; status = 'passed' })
            return $snapshotResult
        } catch {
            $failure = $_
            $transient = $false
            for ($exception = $_.Exception; $null -ne $exception; $exception = $exception.InnerException) {
                # Only sharing/lock violations and paths disappearing during teardown.
                if (($exception -is [IO.IOException] -and ($exception.HResult -band 0xffff) -in @(2,3,32,33)) -or
                    $exception -is [Management.Automation.ItemNotFoundException]) { $transient = $true }
            }
            $remaining = $DeadlineMilliseconds - $timer.ElapsedMilliseconds
            $delay = if ($transient -and $remaining -gt 0) { [Math]::Min(100, $remaining) } else { 0 }
            $Evidence.Add([ordered]@{ attempt = $attempt; elapsedMs = $timer.ElapsedMilliseconds; status = 'failed'; transient = $transient; delayMs = $delay; error = $failure.Exception.Message })
            if (!$delay) { throw $failure }
            & $Wait $delay
            # Discard the failed snapshot and enumerate/hash everything again.
        }
    }
}
if (-not ('PurgeonCliCapture' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading.Tasks;
public static class PurgeonCliCapture {
    public static void ConfigureEncoding(ProcessStartInfo startInfo) {
        // Native CLI output is Rust UTF-8, independent of the Windows code page.
        startInfo.StandardOutputEncoding = new UTF8Encoding(false, true);
        startInfo.StandardErrorEncoding = new UTF8Encoding(false, true);
    }
    public static void StopOwnedProcess(Process process) {
        try {
            if (!process.HasExited) {
                process.Kill(true);
                if (!process.WaitForExit(5000))
                    throw new IOException("CLI cleanup could not confirm process termination.");
            }
        } catch (InvalidOperationException) {
            // Start failed, or the owned process exited while cleanup inspected it.
        }
    }
    public static async Task<string> ReadBounded(StreamReader reader, Process process) {
        var text = new StringBuilder();
        var buffer = new char[4096];
        int count;
        while ((count = await reader.ReadAsync(buffer, 0, buffer.Length)) != 0) {
            if (text.Length + count > 1048576) {
                try { process.Kill(true); } catch (InvalidOperationException) { }
                throw new IOException("CLI output exceeds 1 MiB.");
            }
            text.Append(buffer, 0, count);
        }
        return text.ToString();
    }
}
'@
}
& "$PSScriptRoot/verify-windows-package.ps1" -Directory $Directory -Manifest $Manifest -EvidenceDirectory $EvidenceDirectory
if (Test-Path -LiteralPath $OutputDirectory) { throw 'CLI evidence destination must be new.' }
$out = (New-Item -ItemType Directory -Path $OutputDirectory).FullName
$cases = [Collections.Generic.List[object]]::new()
$report = [ordered]@{ status = 'failed'; cases = $cases; scope = 'Help and invalid requests only; invalid requests may initialize WebView and locks.' }
try {
    if ($Executable) {
        if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') { throw 'Installed EXE tests require a disposable GitHub-hosted runner.' }
        $exe = (Resolve-Path -LiteralPath $Executable).Path
        $expected = Get-Content -LiteralPath $Manifest -Raw | ConvertFrom-Json
        if ((Get-FileHash -LiteralPath $exe).Hash -ne $expected.installed.'purgeon.exe'.sha256) { throw 'Installed executable differs from captured installer payload.' }
        $data = Join-Path $env:APPDATA 'com.seanshaffer.sweepuninstall'
    } else {
        $extract = Join-Path $out 'portable with spaces'
        Expand-Archive -LiteralPath (Join-Path $Directory 'Purgeon-Portable-x64.zip') -DestinationPath $extract
        $exe = Join-Path $extract 'Purgeon-Portable-x64.exe'
        $data = Join-Path $extract 'Purgeon Data'
    }
    function Get-DataSnapshot {
        if (!(Test-Path -LiteralPath $data)) { return @() }
        return @(Get-ChildItem -LiteralPath $data -Recurse -Force | ForEach-Object {
            [ordered]@{ path = [IO.Path]::GetRelativePath($data, $_.FullName); directory = $_.PSIsContainer; hash = if (!$_.PSIsContainer) { (Get-FileHash -LiteralPath $_.FullName).Hash } else { $null } }
        } | Sort-Object { $_.path })
    }
    function Get-DataInventory {
        param([Collections.Generic.List[object]] $Evidence)
        Get-QuiescentInventory -Snapshot { Get-DataSnapshot } -Evidence $Evidence
    }
    $help = Get-Content -LiteralPath "$PSScriptRoot/../src/cli-help.json" -Raw | ConvertFrom-Json
    $normalize = { param($s) $s.Replace("`r`n", "`n").Trim() }
    $requests = @(
        @{ args = @('--help'); code = 0 }, @{ args = @('-h'); code = 0 },
        @{ args = @('/?'); code = 0 }, @{ args = @('--HELP'); code = 0 }, @{ args = @('-H'); code = 0 },
        @{ args = @('--maintenance', '--dry-run'); code = 1; error = 'Unknown option "--dry-run" for --maintenance. Use --help for available options.' },
        @{ args = @('--help', '--maintenance'); code = 1; error = 'Use one command at a time. Run --help on its own for help.' },
        @{ args = @('--unknown-command'); code = 1; error = 'Unknown command "--unknown-command". Use --help for available commands.' },
        @{ args = @('--help', '--help'); code = 1; error = 'Use one command at a time. Run --help on its own for help.' }
    )
    foreach ($request in $requests) {
        $beforeEvidence = [Collections.Generic.List[object]]::new()
        $before = @(Get-DataInventory -Evidence $beforeEvidence)
        $beforeExists = Test-Path -LiteralPath $data
        $psi = [Diagnostics.ProcessStartInfo]::new($exe)
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        [PurgeonCliCapture]::ConfigureEncoding($psi)
        $psi.WorkingDirectory = Split-Path $exe
        foreach ($arg in $request.args) { $psi.ArgumentList.Add($arg) }
        $p = [Diagnostics.Process]::new()
        $p.StartInfo = $psi
        $row = [ordered]@{ args = $request.args; expectedExit = $request.code; status = 'failed'; before = $before; startedUtc = [DateTime]::UtcNow.ToString('o') }
        $cases.Add($row)
        $row.beforeInventoryAttempts = $beforeEvidence
        $row.afterInventoryAttempts = [Collections.Generic.List[object]]::new()
        $stdout = $null
        $stderr = $null
        $started = $false
        try {
            [void]$p.Start()
            $started = $true
            $stdout = [PurgeonCliCapture]::ReadBounded($p.StandardOutput, $p)
            $stderr = [PurgeonCliCapture]::ReadBounded($p.StandardError, $p)
            if (!$p.WaitForExit($TimeoutSeconds * 1000)) {
                $p.Kill($true)
                if (!$p.WaitForExit(5000)) { throw 'CLI timeout; process did not terminate after tree kill.' }
                throw 'CLI timeout.'
            }
            $row.exitCode = $p.ExitCode
            $readers = [Threading.Tasks.Task]::WhenAll([Threading.Tasks.Task[]]@($stdout, $stderr))
            if (!$readers.Wait($TimeoutSeconds * 1000)) { throw 'CLI output streams did not close before deadline.' }
            $row.stdout = $stdout.GetAwaiter().GetResult()
            $row.stderr = $stderr.GetAwaiter().GetResult()
            try { $row.after = @(Get-DataInventory -Evidence $row.afterInventoryAttempts) }
            catch { $row.inventoryError = $_.Exception.Message; throw }
            if ($row.stdout.Length -gt 1048576 -or $row.stderr.Length -gt 1048576) { throw 'CLI output exceeds 1 MiB.' }
            if ($row.exitCode -ne $request.code) { throw "Unexpected exit code: $($row.exitCode)" }
            if ($row.stderr.Trim()) { throw 'CLI contract writes output/errors to stdout; unexpected stderr.' }
            if ($request.code -eq 0) {
                if ((& $normalize $row.stdout) -cne (& $normalize $help)) { throw 'Help differs from shared help.' }
                if (($beforeExists -ne (Test-Path -LiteralPath $data)) -or (($before | ConvertTo-Json -Depth 8 -Compress) -cne ($row.after | ConvertTo-Json -Depth 8 -Compress))) { throw 'Help changed application data.' }
            } elseif ((& $normalize $row.stdout) -cne "Error: $($request.error)") { throw 'Invalid request output differs from expected validation error.' }
            $row.status = 'passed'
        } catch { $row.error = $_.Exception.Message; throw }
        finally {
            # Kill a still-running owned tree on every exception path before disposal.
            # Once its parent exits, Kill(true) cannot find descendants retaining pipes;
            # the read deadline detects that case but does not guarantee their cleanup.
            try {
                if ($started) { [PurgeonCliCapture]::StopOwnedProcess($p) }
            } catch { $row.cleanupError = $_.Exception.Message }
            try {
                if ($stdout -and $stdout.IsCompletedSuccessfully) { $row.stdout = $stdout.Result }
                if ($stderr -and $stderr.IsCompletedSuccessfully) { $row.stderr = $stderr.Result }
                try { $row.after = @(Get-DataInventory -Evidence $row.afterInventoryAttempts) }
                catch {
                    $row.inventoryError = $_.Exception.Message
                    # Evidence capture must not replace the original contract failure.
                    if (!$row.Contains('error')) { throw }
                }
            } finally {
                $row.finishedUtc = [DateTime]::UtcNow.ToString('o')
                $p.Dispose()
            }
        }
    }
    $report.status = 'passed'
} catch { $report.error = $_.Exception.Message; throw }
finally {
    $report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $out 'result.json')
    Write-Output "Packaged CLI evidence: $out/result.json"
}
