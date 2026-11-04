$ErrorActionPreference = 'Stop'
$request = [Console]::In.ReadToEnd() | Microsoft.PowerShell.Utility\ConvertFrom-Json
# SignerCertificate belongs to the same successful Authenticode result.
$signature = Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath ([string]$request.path)
if ($signature.Status -ne 'Valid' -or -not $signature.SignerCertificate) { throw 'Authenticode trust verification failed' }
$sha = [Security.Cryptography.SHA256]::Create()
try { $subject = ([BitConverter]::ToString($sha.ComputeHash($signature.SignerCertificate.SubjectName.RawData))).Replace('-','').ToLowerInvariant() }
finally { $sha.Dispose() }
$version = [Diagnostics.FileVersionInfo]::GetVersionInfo([string]$request.path)
@{subject=$subject;product=$version.ProductName;description=$version.FileDescription} | ConvertTo-Json -Compress
