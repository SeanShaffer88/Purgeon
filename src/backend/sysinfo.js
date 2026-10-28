// System information for the System Info window: one PowerShell sweep collects
// the hardware and OS facts, and buildSections turns them into the plain rows
// the window shows. Temperatures are best-effort: Windows only exposes them on
// some machines, so a temperature is shown only when a sane reading exists.
import { sys } from './sys.js';

const SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
function First($x) { @($x)[0] }
$os = First (Get-CimInstance Win32_OperatingSystem)
$cpu = First (Get-CimInstance Win32_Processor)
$cs = First (Get-CimInstance Win32_ComputerSystem)
$bb = First (Get-CimInstance Win32_BaseBoard)
$nt = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
$tz = First (Get-CimInstance -Namespace 'root\WMI' -ClassName MSAcpi_ThermalZoneTemperature)
$tempC = $null
if ($tz) { $tempC = [math]::Round($tz.CurrentTemperature / 10 - 273.15) }
$mem = @(Get-CimInstance Win32_PhysicalMemory)
$memArr = First (Get-CimInstance Win32_PhysicalMemoryArray)
$phys = @{}
Get-PhysicalDisk | ForEach-Object { $phys[$_.FriendlyName] = $_ }
$temps = @{}
Get-PhysicalDisk | ForEach-Object { try { $c = $_ | Get-StorageReliabilityCounter; if ($c) { $temps[$_.FriendlyName] = $c.Temperature } } catch {} }
$out = [pscustomobject]@{
  os = [pscustomobject]@{ name = [string]$os.Caption; arch = [string]$os.OSArchitecture; version = [string]$nt.DisplayVersion; build = [string]$nt.CurrentBuild; installed = if ($os.InstallDate) { $os.InstallDate.ToString('o') } else { '' }; lastBoot = if ($os.LastBootUpTime) { $os.LastBootUpTime.ToString('o') } else { '' }; computer = [string]$cs.Name; user = [string]$cs.UserName }
  cpu = [pscustomobject]@{ name = [string]$cpu.Name; cores = [int]$cpu.NumberOfCores; threads = [int]$cpu.NumberOfLogicalProcessors; mhz = [int]$cpu.MaxClockSpeed; tempC = $tempC }
  ram = [pscustomobject]@{ totalBytes = [int64]$cs.TotalPhysicalMemory; slots = [int]$memArr.MemoryDevices; modules = @($mem | ForEach-Object { [pscustomobject]@{ bytes = [int64]$_.Capacity; speed = [int]$_.Speed; type = [int]$_.SMBIOSMemoryType; locator = [string]$_.DeviceLocator; maker = [string]$_.Manufacturer } }) }
  board = [pscustomobject]@{ maker = [string]$bb.Manufacturer; product = [string]$bb.Product; version = [string]$bb.Version }
  gpus = @(Get-CimInstance Win32_VideoController | ForEach-Object { [pscustomobject]@{ name = [string]$_.Name; driver = [string]$_.DriverVersion; ramBytes = [int64]$_.AdapterRAM; h = [int]$_.CurrentHorizontalResolution; v = [int]$_.CurrentVerticalResolution; refresh = [int]$_.CurrentRefreshRate } })
  disks = @(Get-CimInstance Win32_DiskDrive | ForEach-Object { $p = $phys[$_.Model]; [pscustomobject]@{ model = [string]$_.Model; bytes = [int64]$_.Size; iface = [string]$_.InterfaceType; bus = if ($p) { [string]$p.BusType } else { '' }; media = if ($p) { [string]$p.MediaType } else { '' }; tempC = $temps[$_.Model] } })
  optical = @(Get-CimInstance Win32_CDROMDrive | ForEach-Object { [string]$_.Name })
  audio = @(Get-CimInstance Win32_SoundDevice | ForEach-Object { [string]$_.Name })
}
$out | ConvertTo-Json -Depth 5 -Compress
`;

// SMBIOS memory type codes (Win32_PhysicalMemory.SMBIOSMemoryType).
export const MEMORY_TYPES = {
  20: 'DDR', 21: 'DDR2', 22: 'DDR2 FB-DIMM', 24: 'DDR3', 26: 'DDR4', 34: 'DDR5',
  29: 'LPDDR', 30: 'LPDDR2', 31: 'LPDDR3', 32: 'LPDDR4', 33: 'LPDDR5',
};
export const memoryTypeName = (code) => MEMORY_TYPES[code] || '';

// A temperature is only shown when it sits in a plausible range; sensor
// fallbacks like 0 or 255 mean "not available", not a real reading.
export const saneTemp = (v) => (typeof v === 'number' && v >= 5 && v <= 115 ? Math.round(v) : null);

export function uptimeText(lastBootIso, now = Date.now()) {
  const t = Date.parse(lastBootIso || '');
  if (!Number.isFinite(t) || t > now) return '';
  const mins = Math.floor((now - t) / 60000);
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (days > 0) return `Up ${days} day${days === 1 ? '' : 's'}, ${hours} hour${hours === 1 ? '' : 's'}`;
  if (hours > 0) return `Up ${hours} hour${hours === 1 ? '' : 's'}, ${m} minute${m === 1 ? '' : 's'}`;
  return `Up ${m} minute${m === 1 ? '' : 's'}`;
}

const gb1 = (bytes) => `${(bytes / 1073741824).toFixed(1)}GB`;
const diskSize = (bytes) => (bytes >= 1e11 ? `${Math.round(bytes / 1e9)}GB` : `${(bytes / 1e9).toFixed(1)}GB`);
const dateOnly = (iso) => (/^\d{4}-\d{2}-\d{2}/.test(iso || '') ? iso.slice(0, 10) : '');

// Raw sweep in, display sections out: [{ title, rows: [{ head, sub?, tempC? }] }].
export function buildSections(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') {
    return [{ title: 'System', rows: [{ head: 'System information could not be read.' }] }];
  }
  const sections = [];
  const os = raw.os || {};
  const osRows = [];
  const osName = String(os.name || '').replace(/^Microsoft\s+/i, '').trim();
  if (osName) osRows.push({ head: `${osName}${os.arch ? ` ${os.arch}` : ''}` });
  const verBits = [os.version && `Version ${os.version}`, os.build && `build ${os.build}`].filter(Boolean).join(' · ');
  if (verBits) osRows.push({ head: verBits });
  const up = uptimeText(os.lastBoot, now);
  if (up) osRows.push({ head: up });
  if (dateOnly(os.installed)) osRows.push({ head: `Installed ${dateOnly(os.installed)}` });
  if (os.computer) osRows.push({ head: `Computer: ${os.computer}${os.user ? ` · User: ${String(os.user).split('\\').pop()}` : ''}` });
  if (osRows.length) sections.push({ title: 'Operating System', rows: osRows });

  const cpu = raw.cpu || {};
  if (cpu.name) {
    const sub = [cpu.cores && `${cpu.cores} cores`, cpu.threads && cpu.threads !== cpu.cores && `${cpu.threads} threads`, cpu.mhz && `up to ${(cpu.mhz / 1000).toFixed(2)} GHz`].filter(Boolean).join(' · ');
    sections.push({ title: 'CPU', rows: [{ head: String(cpu.name).trim(), sub: sub || undefined, tempC: saneTemp(cpu.tempC) ?? undefined }] });
  }

  const ram = raw.ram || {};
  const modules = Array.isArray(ram.modules) ? ram.modules.filter((m) => m.bytes > 0) : [];
  if (ram.totalBytes > 0 || modules.length) {
    const first = modules[0] || {};
    const type = memoryTypeName(first.type);
    const installed = modules.reduce((n, m) => n + m.bytes, 0);
    const head = `${gb1(installed || ram.totalBytes)}${type ? ` ${type}` : ''}${first.speed ? ` @ ${first.speed}MHz` : ''}`;
    const rows = [{ head, sub: ram.slots ? `${modules.length} of ${ram.slots} slots used` : undefined }];
    for (const m of modules) {
      const mt = memoryTypeName(m.type);
      rows.push({ head: `${gb1(m.bytes)}${mt ? ` ${mt}` : ''}${m.speed ? ` ${m.speed}MHz` : ''}${m.locator ? ` — ${m.locator}` : ''}`, sub: m.maker || undefined });
    }
    sections.push({ title: 'RAM', rows });
  }

  const board = raw.board || {};
  if (board.maker || board.product) {
    sections.push({ title: 'Motherboard', rows: [{ head: `${board.maker || ''} ${board.product || ''}`.trim(), sub: board.version ? `Version ${board.version}` : undefined }] });
  }

  const gpus = Array.isArray(raw.gpus) ? raw.gpus.filter((g) => g.name) : [];
  if (gpus.length) {
    sections.push({
      title: 'Graphics',
      rows: gpus.map((g) => ({
        head: g.name,
        sub: [g.ramBytes > 0 && `${gb1(g.ramBytes)} memory`, g.h && g.v && `${g.h}×${g.v}${g.refresh ? ` @ ${g.refresh}Hz` : ''}`, g.driver && `driver ${g.driver}`].filter(Boolean).join(' · ') || undefined,
      })),
    });
  }

  const disks = Array.isArray(raw.disks) ? raw.disks.filter((d) => d.model) : [];
  if (disks.length) {
    sections.push({
      title: 'Storage',
      rows: disks.map((d) => {
        const bits = [d.bus && d.bus !== 'Unknown' ? d.bus : '', d.media && d.media !== 'Unspecified' ? d.media : '', !d.bus && d.iface ? d.iface : ''].filter(Boolean);
        return { head: `${d.bytes ? `${diskSize(d.bytes)} ` : ''}${d.model}${bits.length ? ` (${bits.join(' · ')})` : ''}`, tempC: saneTemp(d.tempC) ?? undefined };
      }),
    });
  }

  const optical = Array.isArray(raw.optical) ? raw.optical.filter(Boolean) : [];
  sections.push({ title: 'Optical Drives', rows: optical.length ? optical.map((n) => ({ head: n })) : [{ head: 'No optical disk drives detected' }] });

  const audio = Array.isArray(raw.audio) ? raw.audio.filter(Boolean) : [];
  sections.push({ title: 'Audio', rows: audio.length ? audio.map((n) => ({ head: n })) : [{ head: 'No audio devices detected' }] });

  return sections;
}

export async function collectSysInfo(now = Date.now()) {
  const out = await sys.runPS(SCRIPT);
  let raw = null;
  try { raw = JSON.parse(out); } catch { raw = null; }
  return { sections: buildSections(raw, now) };
}

// Plain-text rendering of the same sections, for the command line.
export function sectionsToText(sections) {
  return sections.map((s) => `${s.title}\r\n${s.rows.map((r) => `  ${r.head}${r.tempC != null ? `  ${r.tempC} °C` : ''}${r.sub ? `\r\n    ${r.sub}` : ''}`).join('\r\n')}`).join('\r\n\r\n') + '\r\n';
}
