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
Get-NetAdapter -ErrorAction SilentlyContinue | ForEach-Object { $up[[int]$_.ifIndex] = [string]$_.Status }
$adapters = @($rows | Where-Object { $_.InterfaceAlias -notmatch 'Loopback' } | ForEach-Object {
  [pscustomobject]@{ index = [int]$_.InterfaceIndex; alias = [string]$_.InterfaceAlias; status = $up[[int]$_.InterfaceIndex]; servers = @($_.ServerAddresses) }
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
  const raw = await runPSJson(STATUS_SCRIPT).catch(() => null);
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
      doh: dohModeFor(entries),
    };
  });
  return { adapters, dohSupported: !!raw.dohSupported };
}

const checkIndex = (index) => {
  if (!Number.isInteger(index) || index <= 0) throw new Error('Name the network adapter by its number (see --dns list).');
  return index;
};

const denied = (msg) => (/access is denied|0x80070005|PermissionDenied|requires elevation|run as administrator/i.test(msg || '') ? 'Changing DNS settings needs administrator rights. Use File › Restart as Administrator, then try again.' : msg);

// The PowerShell that points one adapter at a provider and registers the
// provider's DoH template the chosen way. Inputs are a validated adapter
// number and a provider from the fixed table above — nothing free-form
// reaches the script.
export function buildApplyScript({ index, provider: providerId, doh: dohMode }) {
  checkIndex(index);
  const p = PROVIDERS[providerId];
  if (!p) throw new Error(`Unknown DNS provider "${providerId}". Use cloudflare, google or quad9.`);
  if (!DOH_MODES.includes(dohMode)) throw new Error('DoH mode must be off, preferred or only.');
  const servers = p.servers.map((s) => `'${s}'`).join(',');
  const autoUpgrade = dohMode === 'off' ? '$False' : '$True';
  const fallback = dohMode === 'preferred' ? '$True' : '$False';
  const dohLines =
    dohMode === 'off'
      ? p.servers
          .map(
            (s) => `
  if (Get-DnsClientDohServerAddress -ServerAddress '${s}' -ErrorAction SilentlyContinue) {
    Set-DnsClientDohServerAddress -ServerAddress '${s}' -DohTemplate '${p.dohTemplate}' -AutoUpgrade $False -AllowFallbackToUdp $False -ErrorAction Stop
  }`
          )
          .join('')
      : p.servers
          .map(
            (s) => `
  if (Get-DnsClientDohServerAddress -ServerAddress '${s}' -ErrorAction SilentlyContinue) {
    Set-DnsClientDohServerAddress -ServerAddress '${s}' -DohTemplate '${p.dohTemplate}' -AutoUpgrade ${autoUpgrade} -AllowFallbackToUdp ${fallback} -ErrorAction Stop
  } else {
    Add-DnsClientDohServerAddress -ServerAddress '${s}' -DohTemplate '${p.dohTemplate}' -AutoUpgrade ${autoUpgrade} -AllowFallbackToUdp ${fallback} -ErrorAction Stop
  }`
          )
          .join('');
  return `
Set-DnsClientServerAddress -InterfaceIndex ${index} -ServerAddresses @(${servers}) -ErrorAction Stop
if (Get-Command Add-DnsClientDohServerAddress -ErrorAction SilentlyContinue) {${dohLines}
}
Clear-DnsClientCache
`;
}

export function buildResetScript({ index }) {
  checkIndex(index);
  return `
Set-DnsClientServerAddress -InterfaceIndex ${index} -ResetServerAddresses -ErrorAction Stop
Clear-DnsClientCache
`;
}

export async function apply(request) {
  const script = buildApplyScript(request);
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
