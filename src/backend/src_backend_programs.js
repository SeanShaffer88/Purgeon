// Enumerates installed desktop programs (registry Uninstall keys) and Store apps.
import { runPSJson, runPS, psq } from './shell.js';
import { sys } from './sys.js';
import * as path from './winpath.js';
import { FileCache } from './filecache.js';
import { createReadContext, forEachRead } from './read-context.js';

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

// Every package, including the framework and system components the old list hid:
// those come back flagged as locked (see shapeStoreApp) so the list is honest
// about what is installed without offering to remove parts of Windows.
const LIST_STORE = `
$out = Get-AppxPackage -ErrorAction SilentlyContinue |
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
      pkgName    = $_.Name
      family     = $_.PackageFamilyName
      name       = $name
      version    = [string]$_.Version
      publisher  = $pub
      location   = [string]$_.InstallLocation
      installDate = ''
      sizeKB     = 0
      store      = $true
      framework  = [bool]$_.IsFramework
      resource   = [bool]$_.IsResourcePackage
      system     = ($_.SignatureKind -eq 'System')
      nonRemovable = [bool]$_.NonRemovable
    }
  }
@($out) | ConvertTo-Json -Compress -Depth 3
`;

// Provisioned copies (the ones Windows adds back for new user accounts).
// Reading them needs administrator rights; without them this returns nothing
// and the list simply shows no provisioned flags.
const LIST_PROVISIONED = `
try {
  $out = Get-AppxProvisionedPackage -Online -ErrorAction Stop |
    ForEach-Object { [pscustomobject]@{ displayName = $_.DisplayName; packageName = $_.PackageName } }
  @($out) | ConvertTo-Json -Compress
} catch { '[]' }
`;

// Plain-words notes for the apps Windows ships, so the list explains itself.
const STORE_NOTES = {
  'microsoft.bingnews': 'News and headlines app from Microsoft.',
  'microsoft.bingweather': 'Weather app from Microsoft.',
  'microsoft.gethelp': 'Help and support app from Microsoft.',
  'microsoft.getstarted': 'Tips app from Microsoft.',
  'microsoft.messaging': 'Messaging app from Microsoft.',
  'microsoft.microsoft3dviewer': '3D Viewer from Microsoft.',
  'microsoft.microsoftofficehub': 'Office hub: links to Office apps and your documents.',
  'microsoft.microsoftsolitairecollection': 'Solitaire card games from Microsoft.',
  'microsoft.mixedrealityportal': 'Mixed Reality Portal for headsets.',
  'microsoft.office.onenote': 'OneNote notebook app from Microsoft.',
  'microsoft.people': 'People (contacts) app from Microsoft.',
  'microsoft.print3d': 'Print 3D from Microsoft.',
  'microsoft.skypeapp': 'Skype app from Microsoft.',
  'microsoft.wallet': 'Microsoft Wallet for passes and payment cards.',
  'microsoft.windowsalarms': 'Clock app: alarms, timers and stopwatch.',
  'microsoft.windowscalculator': 'Calculator app from Microsoft.',
  'microsoft.windowscamera': 'Camera app from Microsoft.',
  'microsoft.windowsmaps': 'Maps app from Microsoft.',
  'microsoft.windowssoundrecorder': 'Voice Recorder from Microsoft.',
  'microsoft.windowsstore': 'Microsoft Store. Needed to install and update Store apps.',
  'microsoft.windows.photos': 'Photos app from Microsoft.',
  'microsoft.windowscommunicationsapps': 'Mail and Calendar apps from Microsoft.',
  'microsoft.microsoftstickynotes': 'Sticky Notes from Microsoft.',
  'microsoft.windowsnotepad': 'Notepad from Microsoft.',
  'microsoft.paint': 'Paint from Microsoft.',
  'microsoft.screensketch': 'Snipping Tool from Microsoft.',
  'microsoft.xboxapp': 'Xbox app from Microsoft.',
  'microsoft.xboxgamingoverlay': 'Xbox Game Bar overlay.',
  'microsoft.xboxgameoverlay': 'Xbox game overlay.',
  'microsoft.xboxidentityprovider': 'Xbox sign-in component.',
  'microsoft.xboxspeechtotextoverlay': 'Xbox speech-to-text overlay.',
  'microsoft.yourphone': 'Phone Link: pairs your phone with this PC.',
  'microsoft.zunemusic': 'Media Player from Microsoft.',
  'microsoft.zunevideo': 'Films & TV app from Microsoft.',
  'clipchamp.clipchamp': 'Clipchamp video editor from Microsoft.',
  'microsoftteams': 'Microsoft Teams chat (personal).',
  'microsoft.todos': 'Microsoft To Do task lists.',
  'microsoft.powerautomatedesktop': 'Power Automate for desktop automation.',
  'microsoft.549981c3f5f10': 'Cortana voice assistant.',
  'microsoft.windowsfeedbackhub': 'Feedback Hub for reporting Windows problems.',
};

export const noteFor = (pkgName) => STORE_NOTES[String(pkgName || '').toLowerCase()] || '';

// Shapes one raw package row for the UI: locked system pieces are listed but
// cannot be removed; provisioned copies are flagged by package name.
export function shapeStoreApp(r, provisioned = {}) {
  const locked = !!(r.framework || r.resource || r.system || r.nonRemovable);
  const provName = provisioned[String(r.pkgName || '').toLowerCase()] || '';
  return {
    ...r,
    locked,
    lockReason: r.framework
      ? 'Framework component other apps rely on'
      : r.resource
        ? 'Resource package (language or scale assets)'
        : r.system
          ? 'System component — removing it can break Windows features'
          : r.nonRemovable
            ? 'Windows marks this app as non-removable'
            : '',
    provisioned: !!provName,
    provisionedName: provName,
    note: noteFor(r.pkgName),
  };
}

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
  const [rows, provisionedRows] = await Promise.all([runPSJson(LIST_STORE), runPSJson(LIST_PROVISIONED).catch(() => [])]);
  const provisioned = {};
  for (const p of provisionedRows) if (p.displayName) provisioned[String(p.displayName).toLowerCase()] = p.packageName || '';
  return rows.map((r) => shapeStoreApp(r, provisioned)).sort((a, b) => a.name.localeCompare(b.name));
}

async function removeStoreApp(fullName) {
  await runPS(`Remove-AppxPackage -Package ${psq(fullName)} -ErrorAction Stop`);
}

// Removes the provisioned copy, so the app does not come back for new user
// accounts. Needs administrator rights (the caller offers it accordingly).
async function removeProvisionedPackage(pkgName) {
  await runPS(`Get-AppxProvisionedPackage -Online -ErrorAction Stop | Where-Object { $_.DisplayName -eq ${psq(pkgName)} } | Remove-AppxProvisionedPackage -Online -ErrorAction Stop | Out-Null`);
}

// Brings a removed app back when any copy of its package is still on the PC
// (another account or the provisioned image): re-registers it for this user.
// Returns false when no copy remains — the caller offers the Store page.
async function restoreStoreApp(pkgName) {
  const out = await runPS(`
$p = Get-AppxPackage -AllUsers -Name ${psq(pkgName)} -ErrorAction SilentlyContinue | Select-Object -First 1
if ($p) {
  Add-AppxPackage -Register "$($p.InstallLocation)\\AppXManifest.xml" -DisableDevelopmentMode -ErrorAction Stop
  'restored'
} else { 'gone' }
`);
  return /\brestored\b/.test(out || '');
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
       $icon = $null; $bmp = $null; $g = $null; $iconBitmap = $null; $ms = $null
       try {
         if (-not (Test-Path -LiteralPath $w.file -PathType Leaf)) { continue }
         $icon = if ($w.file -match '\\.ico$') { New-Object System.Drawing.Icon($w.file, 16, 16) } else { [System.Drawing.Icon]::ExtractAssociatedIcon($w.file) }
         $bmp = New-Object System.Drawing.Bitmap 16, 16
         $g = [System.Drawing.Graphics]::FromImage($bmp)
         $g.InterpolationMode = 'HighQualityBicubic'
         $iconBitmap = $icon.ToBitmap()
         $g.DrawImage($iconBitmap, 0, 0, 16, 16)
         $ms = New-Object System.IO.MemoryStream
         $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
         [pscustomobject]@{ key = $w.key; png = [Convert]::ToBase64String($ms.ToArray()) }
       } catch {} finally {
         foreach ($resource in @($ms, $g, $iconBitmap, $bmp, $icon)) {
           if ($null -ne $resource) { try { [void]$resource.Dispose() } catch {} }
         }
       }
     }
     @($out) | ConvertTo-Json -Compress`;

// 16x16 PNG icons for many programs in one PowerShell call: { [key]: dataURL }.
// Programs can share one icon file, so extraction (and the cache) work per file;
// only files without a current-stamp cache entry go to PowerShell.
async function iconsFor(programs) {
  const context = createReadContext();
  const wanted = programs.map((p) => ({ key: p.key, file: iconPathFor(p) })).filter((w) => w.file);
  if (!wanted.length) return {};
  const files = [...new Set(wanted.map((w) => w.file))];
  const pngByFile = new Map();
  const stamps = new Map();
  // The script answers per input key, so misses are keyed by their own file path.
  let misses = files.map((file) => ({ key: file, file }));
  if (iconCache) {
    misses = [];
    await forEachRead(files, async (file) => {
        const stamp = await context.stampFor(file);
        if (stamp !== null) {
          stamps.set(file, stamp);
          const v = iconCache.hit(file, stamp);
          if (v !== undefined) {
            pngByFile.set(file, v);
            return;
          }
        }
        misses.push({ key: file, file });
      });
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

export { iconsFor, listDesktop, listStore, removeStoreApp, removeProvisionedPackage, restoreStoreApp, iconPathFor, formatDate };
