// DNS server choice and DNS over HTTPS (DoH), per network adapter.
// Reads use the DnsClient PowerShell cmdlets (readable without elevation);
// writes need administrator rights — when Windows refuses, the error says so
// in plain words, the same way the Startup and Services views handle it.
// Changing servers first takes a restore point when the user has that on
// (wired in api.js, like Debloat changes). "Automatic" is not a provider:
// it hands the adapter back to whatever the network assigns (DHCP).
import { runPS, runPSJson } from './shell.js';

// The well-known public resolvers Purgeon offers. Both servers of a provider
// share one DoH template; Windows 11 ships these three as known DoH servers,
// and Purgeon registers the template explicitly so the state is checkable.
export const PROVIDERS = {
  cloudflare: { name: 'Cloudflare', servers: ['1.1.1.1', '1.0.0.1'], dohTemplate: 'https://cloudflare-dns.com/dns-query' },
  google: { name: 'Google', servers: ['8.8.8.8', '8.8.4.4'], dohTemplate: 'https://dns.google/dns-query' },
  quad9: { name: 'Quad9', servers: ['9.9.9.9', '149.112.112.112'], dohTemplate: 'https://dns.quad9.net/dns-query' },
};

export const DOH_MODES = ['off', 'preferred', 'only'];

// Which provider a server list is, exactly: 'automatic' when the adapter has
// no fixed servers, 'custom' when it has some that match no provider.
export function providerForServers(servers) {
  const list = Array.isArray(servers) ? servers.filter(Boolean) : [];
  if (!list.length) return 'automatic';
  for (const [id, p] of Object.entries(PROVIDERS)) {
    if (p.servers.length === list.length && p.servers.every((s) => list.includes(s))) return id;
  }
  return 'custom';
}

// The DoH mode a set of registered entries adds up to, for display.
export function dohModeFor(entries) {
  if (!entries.length || entries.some((e) => !e.autoUpgrade)) return 'off';
  return entries.some((e) => e.fallback) ? 'preferred' : 'only';
}

const STATUS_SCRIPT = `
$rows = Get-DnsClientServerAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue
$up = @{}
$guids = @{}
Get-NetAdapter -ErrorAction SilentlyContinue | ForEach-Object { $up[[int]$_.ifIndex] = [string]$_.Status; $guids[[int]$_.ifIndex] = [string]$_.InterfaceGuid }
$adapters = @($rows | Where-Object { $_.InterfaceAlias -notmatch 'Loopback' } | ForEach-Object {
  $guid = $guids[[int]$_.InterfaceIndex]
  $nagleOff = $false
  if ($guid) {
    $props = Get-ItemProperty -Path "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces\\$guid" -ErrorAction SilentlyContinue
    $nagleOff = ($props.TcpNoDelay -eq 1 -and $props.TcpAckFrequency -eq 1)
  }
  [pscustomobject]@{ index = [int]$_.InterfaceIndex; alias = [string]$_.InterfaceAlias; status = $up[[int]$_.InterfaceIndex]; servers = @($_.ServerAddresses); nagleOff = $nagleOff }
} | Sort-Object @{ Expression = { if ($_.status -eq 'Up') { 0 } else { 1 } } }, alias)
$dohSupported = [bool](Get-Command Get-DnsClientDohServerAddress -ErrorAction SilentlyContinue)
$doh = @()
if ($dohSupported) {
  $doh = @(Get-DnsClientDohServerAddress -ErrorAction SilentlyContinue | ForEach-Object {
    [pscustomobject]@{ server = [string]$_.ServerAddress; template = [string]$_.DohTemplate; autoUpgrade = [bool]$_.AutoUpgrade; fallback = [bool]$_.AllowFallbackToUdp }
  })
}
[pscustomobject]@{ adapters = $adapters; dohSupported = $dohSupported; doh = $doh } | ConvertTo-Json -Depth 4 -Compress
`;

export async function status() {
  const result = await runPSJson(STATUS_SCRIPT);
  const raw = Array.isArray(result) && result.length === 1 ? result[0] : result;
  if (!raw || !Array.isArray(raw.adapters)) throw new Error('Windows did not report any network adapters.');
  const doh = Array.isArray(raw.doh) ? raw.doh : [];
  const adapters = raw.adapters.map((a) => {
    const servers = Array.isArray(a.servers) ? a.servers : [];
    const entries = doh.filter((d) => servers.includes(d.server));
    return {
      index: a.index,
      alias: a.alias || `Adapter ${a.index}`,
      up: a.status === 'Up',
      servers,
      provider: providerForServers(servers),
      doh: servers.length && servers.every((s) => entries.filter((d) => d.server === s).length === 1) ? dohModeFor(entries) : 'off',
      nagleOff: !!a.nagleOff,
    };
  });
  return { adapters, dohSupported: !!raw.dohSupported };
}

const checkIndex = (index) => {
  if (!Number.isSafeInteger(index) || index <= 0 || index > 2147483647) throw new Error('Name the network adapter by its number (see --dns list).');
  return index;
};

const denied = (msg) => (/access is denied|0x80070005|PermissionDenied|requires elevation|run as administrator/i.test(msg || '') ? `Changing network settings needs administrator rights. Use File › Restart as Administrator, then try again. ${msg}` : msg);

// The PowerShell that points one adapter at a provider and registers the
// provider's DoH template the chosen way. Inputs are a validated adapter
// number and a provider from the fixed table above — nothing free-form
// reaches the script.
export function buildApplyScript({ index, provider: providerId, doh: dohMode }) {
  checkIndex(index);
  if (typeof providerId !== 'string' || !Object.hasOwn(PROVIDERS, providerId)) throw new Error(`Unknown DNS provider "${providerId}". Use cloudflare, google or quad9.`);
  if (!DOH_MODES.includes(dohMode)) throw new Error('DoH mode must be off, preferred or only.');
  return dnsTransaction(index, PROVIDERS[providerId], dohMode);
}

// DNS server registration is machine-wide. Prepare every change before touching
// it, refuse conflicts with another adapter, and retain the original DHCP mode.
// These are synchronous best-effort rollbacks, not crash recovery journals.
function dnsTransaction(index, provider, mode) {
  const reset = !provider;
  const servers = provider ? provider.servers.map((s) => `'${s}'`).join(',') : '';
  return `
$ErrorActionPreference = 'Stop'
$index = ${index}
$desired = @(${servers})
$reset = ${reset ? '$true' : '$false'}
$mode = '${mode || 'off'}'
$template = '${provider?.dohTemplate || ''}'
function Read-DnsState {
  $adapter = @(Get-NetAdapter -ErrorAction Stop | Where-Object { $_.ifIndex -eq $index })
  if ($adapter.Count -ne 1) { throw 'That network adapter could not be found uniquely.' }
  $key = Get-Item -LiteralPath "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces\\$($adapter[0].InterfaceGuid)" -ErrorAction Stop
  try { $explicit = -not [string]::IsNullOrWhiteSpace([string]$key.GetValue('NameServer', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)) } finally { $key.Close() }
  $rows = @(Get-DnsClientServerAddress -InterfaceIndex $index -AddressFamily IPv4 -ErrorAction Stop)
  if ($rows.Count -ne 1) { throw 'Windows did not report the adapter DNS configuration uniquely.' }
  [pscustomobject]@{ Explicit = $explicit; Servers = @($rows[0].ServerAddresses); InputObject = $rows[0] }
}
function Same-Servers($a, $b) { (@($a) -join ',') -ceq (@($b) -join ',') }
function Same-Doh($a, $b) {
  $null -ne $a -and $null -ne $b -and $a.DohTemplate -ceq $b.DohTemplate -and [bool]$a.AutoUpgrade -eq [bool]$b.AutoUpgrade -and [bool]$a.AllowFallbackToUdp -eq [bool]$b.AllowFallbackToUdp
}
function Read-Doh($address) {
  $found = @(Get-DnsClientDohServerAddress -ErrorAction Stop | Where-Object { $_.ServerAddress -eq $address })
  if ($found.Count -gt 1) { throw 'Windows reported duplicate DoH registrations.' }
  if ($found.Count) { $found[0] }
}
$original = Read-DnsState
if ($original.Explicit -and -not $original.Servers.Count) { throw 'The original DNS configuration cannot be restored safely.' }
$plans = @()
if (-not $reset) {
  $supported = [bool](Get-Command Get-DnsClientDohServerAddress -ErrorAction SilentlyContinue)
  if ($mode -ne 'off' -and -not $supported) { throw 'Encrypted DNS is not supported on this Windows installation. No settings changed.' }
  if ($supported) {
    $others = @(Get-DnsClientServerAddress -AddressFamily IPv4 -ErrorAction Stop | Where-Object { $_.InterfaceIndex -ne $index })
    foreach ($address in $desired) {
      $before = Read-Doh $address
      if ($mode -eq 'off' -and $null -eq $before) { continue }
      $after = [pscustomobject]@{ ServerAddress = $address; DohTemplate = $template; AutoUpgrade = ($mode -ne 'off'); AllowFallbackToUdp = ($mode -eq 'preferred') }
      if (Same-Doh $before $after) { continue }
      if (@($others | Where-Object { @($_.ServerAddresses) -contains $address }).Count) { throw 'That DoH registration is shared by another adapter. No settings changed.' }
      $needed = if ($null -eq $before) { @('Add-DnsClientDohServerAddress', 'Remove-DnsClientDohServerAddress') } else { @('Set-DnsClientDohServerAddress') }
      foreach ($command in $needed) { if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "Required DoH operation $command is unavailable. No settings changed." } }
      $plans += [pscustomobject]@{ Address = $address; Before = $before; After = $after }
    }
  }
}
$touched = @()
$dnsTouched = $false
try {
  foreach ($plan in $plans) {
    $touched += $plan
    $entry = $plan.After
    if ($null -eq $plan.Before) { Add-DnsClientDohServerAddress -ServerAddress $plan.Address -DohTemplate $entry.DohTemplate -AutoUpgrade $entry.AutoUpgrade -AllowFallbackToUdp $entry.AllowFallbackToUdp -ErrorAction Stop }
    else { Set-DnsClientDohServerAddress -ServerAddress $plan.Address -DohTemplate $entry.DohTemplate -AutoUpgrade $entry.AutoUpgrade -AllowFallbackToUdp $entry.AllowFallbackToUdp -ErrorAction Stop }
    if (-not (Same-Doh (Read-Doh $plan.Address) $entry)) { throw 'DoH registration verification failed.' }
  }
  $dnsTouched = $true
  if ($reset) { Set-DnsClientServerAddress -InputObject $original.InputObject -ResetServerAddresses -ErrorAction Stop }
  else { Set-DnsClientServerAddress -InputObject $original.InputObject -ServerAddresses $desired -ErrorAction Stop }
  $actual = Read-DnsState
  if ($reset) { if ($actual.Explicit) { throw 'Automatic DNS verification failed.' } }
  elseif (-not $actual.Explicit -or -not (Same-Servers $actual.Servers $desired)) { throw 'DNS server verification failed.' }
  Clear-DnsClientCache -ErrorAction Stop
} catch {
  $failure = $_.Exception.Message
  $rollback = @()
  if ($dnsTouched) {
    try {
      if ($original.Explicit) { Set-DnsClientServerAddress -InputObject $original.InputObject -ServerAddresses $original.Servers -ErrorAction Stop }
      else { Set-DnsClientServerAddress -InputObject $original.InputObject -ResetServerAddresses -ErrorAction Stop }
      $restored = Read-DnsState
      if ($restored.Explicit -ne $original.Explicit -or ($original.Explicit -and -not (Same-Servers $restored.Servers $original.Servers))) { throw 'DNS rollback verification failed.' }
    } catch { $rollback += $_.Exception.Message }
  }
  for ($i = $touched.Count - 1; $i -ge 0; $i--) {
    $plan = $touched[$i]
    try {
      if ($null -eq $plan.Before) {
        if ($null -ne (Read-Doh $plan.Address)) { Remove-DnsClientDohServerAddress -ServerAddress $plan.Address -Confirm:$false -ErrorAction Stop }
        if ($null -ne (Read-Doh $plan.Address)) { throw 'DoH rollback removal verification failed.' }
      } else {
        $entry = $plan.Before
        Set-DnsClientDohServerAddress -ServerAddress $plan.Address -DohTemplate $entry.DohTemplate -AutoUpgrade $entry.AutoUpgrade -AllowFallbackToUdp $entry.AllowFallbackToUdp -ErrorAction Stop
        if (-not (Same-Doh (Read-Doh $plan.Address) $entry)) { throw 'DoH rollback verification failed.' }
      }
    } catch { $rollback += $_.Exception.Message }
  }
  if ($rollback.Count) { throw "$failure Rollback failed; settings may be partially changed: $($rollback -join '; ')" }
  throw "$failure Previous settings restored."
}
`;
}

export function buildResetScript({ index }) {
  checkIndex(index);
  return dnsTransaction(index);
}

export async function apply(request) {
  const script = buildApplyScript(request);
  await runPS(script).catch((e) => {
    throw new Error(denied(e.message));
  });
  return status();
}

// Nagle's algorithm batches small outgoing packets briefly before sending.
// Turning it off (TcpNoDelay=1 with TcpAckFrequency=1) sends them at once,
// which can shave delay in some online games; most programs see no
// difference and it can waste a little bandwidth. The values live under the
// adapter's own interface key; the script finds that key from the adapter
// number, so no identifier from the caller reaches the registry path.
// "Windows default" removes both values — a fresh Windows has neither.
export function buildNagleScript({ index, off }) {
  checkIndex(index);
  if (typeof off !== 'boolean') throw new Error('Say whether Nagle should be off or back to the Windows default.');
  return `
$ErrorActionPreference = 'Stop'
$adapter = @(Get-NetAdapter -ErrorAction Stop | Where-Object { $_.ifIndex -eq ${index} })
if ($adapter.Count -ne 1) { throw 'That network adapter could not be found uniquely.' }
$path = "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces\\$($adapter[0].InterfaceGuid)"
$names = @('TcpNoDelay', 'TcpAckFrequency')
function Read-NagleValue($name) {
  $key = Get-Item -LiteralPath $path -ErrorAction Stop
  try {
    $present = @($key.GetValueNames()) -contains $name
    if ($present) {
      [pscustomobject]@{ Present = $true; Kind = [string]$key.GetValueKind($name); Value = $key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
    } else { [pscustomobject]@{ Present = $false; Kind = ''; Value = $null } }
  } finally { $key.Close() }
}
function Same-NagleValue($a, $b) {
  $a.Present -eq $b.Present -and (-not $a.Present -or ($a.Kind -ceq $b.Kind -and (ConvertTo-Json -InputObject $a.Value -Compress) -ceq (ConvertTo-Json -InputObject $b.Value -Compress)))
}
$original = @{}
foreach ($name in $names) { $original[$name] = Read-NagleValue $name }
$touched = @()
try {
  foreach ($name in $names) {
    $touched += $name
    ${off ? "New-ItemProperty -Path $path -Name $name -PropertyType DWord -Value 1 -Force -ErrorAction Stop | Out-Null" : "if ($original[$name].Present) { Remove-ItemProperty -Path $path -Name $name -ErrorAction Stop }"}
    $expected = [pscustomobject]@{ Present = ${off ? '$true' : '$false'}; Kind = '${off ? 'DWord' : ''}'; Value = ${off ? '1' : '$null'} }
    if (-not (Same-NagleValue (Read-NagleValue $name) $expected)) { throw "Nagle setting verification failed for $name." }
  }
} catch {
  $failure = $_.Exception.Message
  $rollback = @()
  foreach ($name in $touched) {
    try {
      $entry = $original[$name]
      if ($entry.Present) { New-ItemProperty -Path $path -Name $name -PropertyType $entry.Kind -Value $entry.Value -Force -ErrorAction Stop | Out-Null }
      elseif ((Read-NagleValue $name).Present) { Remove-ItemProperty -Path $path -Name $name -ErrorAction Stop }
      if (-not (Same-NagleValue (Read-NagleValue $name) $entry)) { throw "Nagle rollback verification failed for $name." }
    } catch { $rollback += $_.Exception.Message }
  }
  if ($rollback.Count) { throw "$failure Rollback failed; settings may be partially changed: $($rollback -join '; ')" }
  throw "$failure Previous settings restored."
}
`;
}

export async function setNagle(request) {
  const script = buildNagleScript(request);
  await runPS(script).catch((e) => {
    throw new Error(denied(e.message));
  });
  return status();
}

export async function reset({ index }) {
  const script = buildResetScript({ index });
  await runPS(script).catch((e) => {
    throw new Error(denied(e.message));
  });
  return status();
}
