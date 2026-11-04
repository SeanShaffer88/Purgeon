param([Parameter(Mandatory)][string]$Binary, [string]$CaptureContext)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/windows-package-tools.ps1"
if (-not $env:CODE_SIGN_CERT -and -not $env:CODE_SIGN_PASSWORD) {
  Write-Host 'Unsigned development artifact: no signing credentials configured.'
  Save-InstallerPayload $Binary $CaptureContext
  return
}
if (-not $env:CODE_SIGN_CERT -or -not $env:CODE_SIGN_PASSWORD) { throw 'Both signing credentials are required.' }
if (-not (Test-Path -LiteralPath $Binary -PathType Leaf)) { throw 'The signing input does not exist.' }
$tool = Get-ChildItem -LiteralPath 'C:\Program Files (x86)\Windows Kits\10\bin' -Filter signtool.exe -Recurse | Where-Object FullName -Match '\\x64\\' | Sort-Object FullName -Descending | Select-Object -First 1
if (-not $tool) { throw 'Windows SDK signtool is required.' }
$certificate = Join-Path ([IO.Path]::GetTempPath()) ('purgeon-sign-' + [guid]::NewGuid() + '.pfx')
try {
  [IO.File]::WriteAllBytes($certificate, [Convert]::FromBase64String($env:CODE_SIGN_CERT))
  & $tool.FullName sign /fd SHA256 /f $certificate /p $env:CODE_SIGN_PASSWORD /tr https://timestamp.digicert.com /td SHA256 /d Purgeon $Binary
  if ($LASTEXITCODE) { throw 'Signing failed.' }
  & $tool.FullName verify /pa /all $Binary
  if ($LASTEXITCODE) { throw 'Signature verification failed.' }
} finally { Remove-Item -LiteralPath $certificate -Force -ErrorAction SilentlyContinue }
# Tauri CLI 2.12.4 invokes this after setting NSS, before NSIS compilation:
# https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.4/crates/tauri-bundler/src/bundle.rs
Save-InstallerPayload $Binary $CaptureContext
