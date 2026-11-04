$ErrorActionPreference = 'Stop'
$request = [Console]::In.ReadToEnd() | Microsoft.PowerShell.Utility\ConvertFrom-Json
Microsoft.PowerShell.Utility\Add-Type -AssemblyName System.Net.Http
$uri = [uri]$request.url
$allowed = [string]$request.hostName
$handler = New-Object Net.Http.HttpClientHandler
$handler.AllowAutoRedirect = $false
$client = New-Object Net.Http.HttpClient($handler)
$client.Timeout = [TimeSpan]::FromSeconds(180)
$cts = New-Object Threading.CancellationTokenSource([TimeSpan]::FromSeconds(180))
$response = $null; $stream = $null; $output = $null
try {
    for ($hop = 0; $hop -le 5; $hop++) {
        if ($uri.Scheme -cne 'https' -or $uri.IdnHost -cne $allowed -or $uri.UserInfo -or -not $uri.IsDefaultPort -or $uri.Fragment) { throw 'Unapproved download endpoint' }
        $response = $client.GetAsync($uri,[Net.Http.HttpCompletionOption]::ResponseHeadersRead,$cts.Token).GetAwaiter().GetResult()
        if ([int]$response.StatusCode -in @(301,302,303,307,308)) {
            if ($hop -eq 5 -or -not $response.Headers.Location) { throw 'Redirect limit or location rejected' }
            $next = New-Object uri($uri,$response.Headers.Location)
            $response.Dispose(); $response = $null; $uri = $next; continue
        }
        $response.EnsureSuccessStatusCode() | Out-Null
        break
    }
    if ($response.Content.Headers.ContentLength -gt 134217728) { throw 'Download exceeds 128 MiB' }
    $expected = $response.Content.Headers.ContentLength
    $stream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
    # Native retains the original read handle without delete sharing. This
    # writer shares read; the original handle shares write until sealing.
    $output = [IO.File]::Open([string]$request.path,[IO.FileMode]::Open,[IO.FileAccess]::Write,[IO.FileShare]::ReadWrite)
    if ($output.Length -ne 0) { throw 'Destination was modified before writer admission' }
    $buffer = New-Object byte[] 65536
    [long]$total = 0
    while (($n = $stream.ReadAsync($buffer,0,$buffer.Length,$cts.Token).GetAwaiter().GetResult()) -gt 0) {
        $total += $n
        if ($total -gt 134217728) { throw 'Streaming download exceeds 128 MiB' }
        $output.Write($buffer,0,$n)
    }
    if ($total -eq 0 -or ($null -ne $expected -and $total -ne $expected)) { throw 'Empty or truncated download' }
    $output.Flush($true)
    @{bytes=$total} | ConvertTo-Json -Compress
} finally {
    if ($output) { $output.Dispose() }; if ($stream) { $stream.Dispose() }
    if ($response) { $response.Dispose() }; $client.Dispose(); $handler.Dispose(); $cts.Dispose()
}
