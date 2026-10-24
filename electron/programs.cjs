// Enumerates installed desktop programs (registry Uninstall keys) and Store apps.
const { runPSJson, runPS, psq } = require('./shell.cjs');

const LIST_DESKTOP = `
$roots = @(
  @{ hive='HKLM'; path='SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall'; arch='x64' },
  @{ hive='HKLM'; path='SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'; arch='x86' },
  @{ hive='HKCU'; path='Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'; arch='user' }
)
$out = foreach ($r in $roots) {
  $root = "Registry::$($r.hive)\\$($r.path)"
  if (-not (Test-Path $root)) { continue }
  foreach ($k in Get-ChildItem $root -ErrorAction SilentlyContinue) {
    $p = Get-ItemProperty $k.PSPath -ErrorAction SilentlyContinue
    if (-not $p.DisplayName) { continue }
    if ($p.SystemComponent -eq 1 -or $p.ParentKeyName -or $p.ReleaseType -in 'Update','Hotfix','Security Update') { continue }
    [pscustomobject]@{
      key         = "$($r.hive)\\$($r.path)\\$($k.PSChildName)"
      name        = [string]$p.DisplayName
      version     = [string]$p.DisplayVersion
      publisher   = [string]$p.Publisher
      installDate = [string]$p.InstallDate
      sizeKB      = [int64]$p.EstimatedSize
      location    = [string]$p.InstallLocation
      uninstall   = [string]$p.UninstallString
      quiet       = [string]$p.QuietUninstallString
      icon        = [string]$p.DisplayIcon
      helpLink    = [string]$p.HelpLink
      urlInfo     = [string]$p.URLInfoAbout
      arch        = $r.arch
    }
  }
}
@($out) | ConvertTo-Json -Compress -Depth 3
`;

const LIST_STORE = `
$out = Get-AppxPackage -ErrorAction SilentlyContinue |
  Where-Object { -not $_.IsFramework -and $_.SignatureKind -ne 'System' -and -not $_.IsResourcePackage } |
  ForEach-Object {
    $name = $_.Name
    $pub = if ($_.Publisher -match 'O=([^,]+)') { $matches[1] } elseif ($_.Publisher -match 'CN=([^,]+)') { $matches[1] } else { '' }
    try {
      $m = Get-AppxPackageManifest $_ -ErrorAction Stop
      $dn = [string]$m.Package.Properties.DisplayName; if ($dn -and -not $dn.StartsWith('ms-resource')) { $name = $dn }
      $pd = [string]$m.Package.Properties.PublisherDisplayName; if ($pd -and -not $pd.StartsWith('ms-resource')) { $pub = $pd }
    } catch {}
    [pscustomobject]@{
      key        = $_.PackageFullName
      name       = $name
      version    = [string]$_.Version
      publisher  = $pub
      location   = [string]$_.InstallLocation
      installDate = ''
      sizeKB     = 0
      store      = $true
    }
  }
@($out) | ConvertTo-Json -Compress -Depth 3
`;

function formatDate(raw) {
  if (/^\d{8}$/.test(raw || '')) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  return raw || '';
}

async function listDesktop() {
  const rows = await runPSJson(LIST_DESKTOP);
  const seen = new Set();
  return rows
    .map((r) => ({ ...r, installDate: formatDate(r.installDate) }))
    .filter((r) => {
      const id = `${r.name}|${r.version}|${r.arch}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function listStore() {
  const rows = await runPSJson(LIST_STORE);
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

async function removeStoreApp(fullName) {
  await runPS(`Remove-AppxPackage -Package ${psq(fullName)} -ErrorAction Stop`);
}

// DisplayIcon is "path,index" and sometimes quoted. Fall back to the uninstaller exe.
function iconPathFor(p) {
  const clean = (s) => (s || '').trim().replace(/^"([^"]+)".*$/, '$1').replace(/,-?\d+$/, '').trim();
  const fromIcon = clean(p.icon);
  if (fromIcon && /\.(exe|ico|dll)$/i.test(fromIcon)) return fromIcon;
  const m = (p.uninstall || '').match(/^"([^"]+\.exe)"|^(\S+\.exe)/i);
  if (m && !/msiexec/i.test(m[1] || m[2])) return m[1] || m[2];
  return null;
}

module.exports = { listDesktop, listStore, removeStoreApp, iconPathFor, formatDate };
