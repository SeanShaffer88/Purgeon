[CmdletBinding(DefaultParameterSetName = 'Probe')]
param(
    [Parameter(Mandatory, ParameterSetName = 'Probe')][string] $ProbeExecutable,
    [Parameter(Mandatory, ParameterSetName = 'Release')][string] $Directory,
    [Parameter(Mandatory, ParameterSetName = 'Release')][string] $Manifest,
    [Parameter(ParameterSetName = 'Release')][string] $EvidenceDirectory,
    [Parameter(Mandatory)][string] $OutputFile,
    [ValidateRange(1, 120)][int] $TimeoutSeconds = 30
)

. "$PSScriptRoot/windows-package-tools.ps1"

if (-not ('PurgeonPeProbeCapture' -as [type])) {
    Add-Type -TypeDefinition @'
using System.IO;
using System.Text;
using System.Threading.Tasks;

public static class PurgeonPeProbeCapture {
    public static async Task<string> Read(StreamReader reader) {
        var text = new StringBuilder();
        var buffer = new char[512];
        int count;
        while ((count = await reader.ReadAsync(buffer, 0, buffer.Length)) != 0) {
            if (text.Length + count > 4096)
                throw new IOException("Probe output exceeds its limit.");
            text.Append(buffer, 0, count);
        }
        return text.ToString();
    }
}
'@
}

function Invoke-PeWorkerProbe([string] $Executable, [System.Collections.IDictionary] $Report) {
    $info = [Diagnostics.ProcessStartInfo]::new($Executable)
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = [Text.UTF8Encoding]::new($false, $true)
    $info.StandardErrorEncoding = $info.StandardOutputEncoding
    $info.WorkingDirectory = Split-Path -Parent $Executable
    $info.ArgumentList.Add('--qualify-pe-worker-panic')
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $info
    $started = $false
    $timer = [Diagnostics.Stopwatch]::StartNew()
    try {
        $Report.stage = 'process-start'
        $started = $process.Start()
        if (!$started) { throw 'Probe process could not start.' }
        $stdout = [PurgeonPeProbeCapture]::Read($process.StandardOutput)
        $stderr = [PurgeonPeProbeCapture]::Read($process.StandardError)
        $Report.stage = 'process-exit'
        if (!$process.WaitForExit($TimeoutSeconds * 1000)) { throw 'Probe process timed out.' }
        $Report.exitCode = $process.ExitCode
        $Report.stage = 'output-capture'
        $remaining = [Math]::Max(0, ($TimeoutSeconds * 1000) - $timer.ElapsedMilliseconds)
        $readers = [Threading.Tasks.Task]::WhenAll([Threading.Tasks.Task[]] @($stdout, $stderr))
        if (!$readers.Wait([int] $remaining)) { throw 'Probe output did not close.' }
        return @{ stdout = $stdout.GetAwaiter().GetResult().Trim(); stderr = $stderr.GetAwaiter().GetResult().Trim() }
    } finally {
        try {
            if ($started -and !$process.HasExited) {
                try { $process.Kill($true) }
                catch [InvalidOperationException] { if (!$process.HasExited) { throw } }
                if (!$process.WaitForExit(5000)) { throw 'Probe cleanup could not confirm termination.' }
            }
        } finally {
            $Report.elapsedMs = $timer.ElapsedMilliseconds
            $process.Dispose()
        }
    }
}

$mode = $PSCmdlet.ParameterSetName
$output = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputFile)
if (Test-Path -LiteralPath $output) { throw 'Probe evidence file must be new.' }
New-Item -ItemType Directory -Path (Split-Path -Parent $output) -Force | Out-Null
$scratch = [IO.Directory]::CreateTempSubdirectory('purgeon-pe-worker-').FullName
$report = [ordered]@{ schemaVersion = 1; mode = $mode; status = 'failed'; stage = 'package'; exitCode = $null; elapsedMs = $null }
try {
    $portableName = 'Purgeon-Portable-x64.exe'
    if ($mode -eq 'Release') {
        & "$PSScriptRoot/verify-windows-package.ps1" -Directory $Directory -Manifest $Manifest -EvidenceDirectory $EvidenceDirectory | Out-Null
        $archive = Join-Path $Directory 'Purgeon-Portable-x64.zip'
    } else {
        $source = (Resolve-Path -LiteralPath $ProbeExecutable).Path
        Assert-PeMachine $source 0x8664
        $identity = Get-PackageFileIdentity $source
        $stage = New-Item -ItemType Directory -Path (Join-Path $scratch 'staging')
        Copy-Item -LiteralPath $source -Destination (Join-Path $stage.FullName $portableName)
        Copy-Item -LiteralPath "$PSScriptRoot/../LICENSE", "$PSScriptRoot/../PORTABLE.txt" -Destination $stage.FullName
        $archive = Join-Path $scratch 'probe-portable.zip'
        Compress-Archive -LiteralPath @((Join-Path $stage.FullName $portableName), (Join-Path $stage.FullName 'LICENSE'), (Join-Path $stage.FullName 'PORTABLE.txt')) -DestinationPath $archive
    }
    $extract = Join-Path $scratch 'portable with spaces'
    Expand-Archive -LiteralPath $archive -DestinationPath $extract
    $exe = Join-Path $extract $portableName
    Assert-PeMachine $exe 0x8664
    if ($mode -eq 'Release') {
        $expected = Get-Content -LiteralPath $Manifest -Raw | ConvertFrom-Json
        if ((Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash -ne $expected.portable.$portableName) {
            throw 'Extracted executable differs from the release manifest.'
        }
    } else { Assert-PackageFileIdentity $exe $identity }
    $report.packageSha256 = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
    $report.executableSha256 = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash

    $result = Invoke-PeWorkerProbe $exe $report
    $report.stage = 'result-contract'
    if ($mode -eq 'Release') {
        if ($report.exitCode -ne 2 -or $result.stdout -or $result.stderr -cne 'PE worker qualification is unavailable') {
            throw 'Default portable executable did not refuse the qualification request.'
        }
        $report.qualificationRefused = $true
    } else {
        if ($report.exitCode -ne 0 -or $result.stderr -or $result.stdout -match '[\r\n]') {
            throw 'Qualification executable did not produce a successful single-line result.'
        }
        $document = [Text.Json.JsonDocument]::Parse($result.stdout)
        try {
            $payload = $document.RootElement
            if ($payload.ValueKind -ne [Text.Json.JsonValueKind]::Object -or @($payload.EnumerateObject()).Count -ne 4 -or
                $payload.GetProperty('contained').ValueKind -ne [Text.Json.JsonValueKind]::True -or
                $payload.GetProperty('childReaped').ValueKind -ne [Text.Json.JsonValueKind]::True -or
                $payload.GetProperty('nextArchitecture').GetString() -cne 'x64' -or
                $payload.GetProperty('diagnostic').GetString() -cne 'PE architecture worker unavailable') {
                throw 'Qualification evidence did not confirm containment, cleanup, recovery and diagnostic redaction.'
            }
        } finally { $document.Dispose() }
        $report.contained = $true
        $report.childReaped = $true
        $report.nextArchitecture = 'x64'
        $report.diagnostic = 'PE architecture worker unavailable'
    }
    $report.stage = 'portable-footprint'
    if (Test-Path -LiteralPath (Join-Path $extract 'Purgeon Data')) { throw 'Probe initialized portable application data.' }
    $report.status = 'passed'
} catch {
    # Child output and exception messages can contain machine paths. Upload only the fixed stage and observed code.
    throw "Packaged PE worker qualification failed during $($report.stage)."
} finally {
    try {
        $owned = Get-Item -LiteralPath $scratch -Force
        if ($owned.FullName -cne $scratch -or $owned.Attributes -band [IO.FileAttributes]::ReparsePoint -or
            $owned.Parent.FullName.TrimEnd('\') -ine [IO.Path]::GetTempPath().TrimEnd('\')) {
            throw 'Probe scratch directory identity could not be confirmed.'
        }
        Remove-Item -LiteralPath $owned.FullName -Force -Recurse -ErrorAction Stop
    } catch {
        $report.status = 'failed'
        $report.stage = 'cleanup'
        throw 'Packaged PE worker scratch cleanup failed.'
    } finally {
        $report | ConvertTo-Json | Set-Content -LiteralPath $output -Encoding utf8
    }
}
