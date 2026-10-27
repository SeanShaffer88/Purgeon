// Enumerates installed desktop programs (registry Uninstall keys) and Store apps.
import { runPSJson, runPS, psq } from './shell.js';
import { sys } from './sys.js';
import * as path from './winpath.js';
import { FileCache } from './filecache.js';

// Icon cache: extracted PNGs keyed by each icon file's stamp, so repeat program-list
// loads skip the PowerShell extraction for files that have not changed. Null until
// setRoot runs (the CLI and tests), in which case icons are extracted uncached.
let iconCache = null;

export const setRoot = async (d) => {
  await sys.makeDir(d);
  iconCache = new FileCache(path.join(d, 'icons.json'));
  await iconCache.init();
};

const LIST_DESKTOP = `
$nativeArch = if ([Environment]::Is64BitOperatingSystem) { 'x64' } else { 'x86' }
$roots = @(
  @{ hive='HKLM'; path='SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall'; arch=$nativeArch },
  @{ hive='HKLM'; path='SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'; arch='x86' },
  @{ hive='HKCU'; path='Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'; arch='user' }
)
$out = foreach ($r in $roots) {
  $root = "Registry::$($r.hive)\\$($r.path)"
  if (-not (Test-Path $root)) { continue }
  foreach ($k in Get-ChildItem $root -ErrorAction SilentlyContinue) {
    $p = Get-ItemProperty -LiteralPath $k.PSPath -ErrorAction SilentlyContinue
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
      portable    = [bool]$p.SweepUninstallPortable
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

const ICONS_PS = `
     Add-Type -AssemblyName System.Drawing
     $in = [Console]::In.ReadToEnd() | ConvertFrom-Json
     $out = foreach ($w in $in) {
       try {
         if (-not (Test-Path -LiteralPath $w.file -PathType Leaf)) { continue }
         $icon = if ($w.file -match '\\.ico$') { New-Object System.Drawing.Icon($w.file, 16, 16) } else { [System.Drawing.Icon]::ExtractAssociatedIcon($w.file) }
         $bmp = New-Object System.Drawing.Bitmap 16, 16
         $g = [System.Drawing.Graphics]::FromImage($bmp)
         $g.InterpolationMode = 'HighQualityBicubic'
         $g.DrawImage($icon.ToBitmap(), 0, 0, 16, 16)
         $ms = New-Object System.IO.MemoryStream
         $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
         [pscustomobject]@{ key = $w.key; png = [Convert]::ToBase64String($ms.ToArray()) }
         $g.Dispose(); $bmp.Dispose(); $icon.Dispose()
       } catch {}
     }
     @($out) | ConvertTo-Json -Compress`;

// 16x16 PNG icons for many programs in one PowerShell call: { [key]: dataURL }.
// Programs can share one icon file, so extraction (and the cache) work per file;
// only files without a current-stamp cache entry go to PowerShell.
async function iconsFor(programs) {
  const wanted = programs.map((p) => ({ key: p.key, file: iconPathFor(p) })).filter((w) => w.file);
  if (!wanted.length) return {};
  const files = [...new Set(wanted.map((w) => w.file))];
  const pngByFile = new Map();
  const stamps = new Map();
  // The script answers per input key, so misses are keyed by their own file path.
  let misses = files.map((file) => ({ key: file, file }));
  if (iconCache) {
    misses = [];
    await Promise.all(
      files.map(async (file) => {
        const stamp = await iconCache.stampFor(file);
        if (stamp !== null) {
          stamps.set(file, stamp);
          const v = iconCache.hit(file, stamp);
          if (v !== undefined) {
            pngByFile.set(file, v);
            return;
          }
        }
        misses.push({ key: file, file });
      })
    );
  }
  if (misses.length) {
    const rows = await runPSJson(ICONS_PS, { input: JSON.stringify(misses) }).catch(() => []);
    for (const r of rows) {
      pngByFile.set(r.key, r.png);
      const stamp = stamps.get(r.key);
      if (iconCache && stamp) iconCache.put(r.key, stamp, r.png);
    }
    if (iconCache) await iconCache.save();
  }
  const out = {};
  for (const w of wanted) {
    const png = pngByFile.get(w.file);
    if (png) out[w.key] = `data:image/png;base64,${png}`;
  }
  return out;
}

export { iconsFor, listDesktop, listStore, removeStoreApp, iconPathFor, formatDate };
