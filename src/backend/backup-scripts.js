import { psq } from './shell.js';

export const taskRemovalScript = (target, file) => `
$ErrorActionPreference = 'Stop'
$tasks = @(Get-ScheduledTask -ErrorAction Stop | Where-Object { ($_.TaskPath + $_.TaskName) -ceq ${psq(target)} })
if (-not $tasks.Count) { 'GONE'; return }
if ($tasks.Count -ne 1) { throw 'Task identity is ambiguous' }
$t = $tasks[0]
$text = Export-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath -ErrorAction Stop
if (-not ([string]$text).Trim()) { throw 'Task backup is empty' }
[xml]$exported = $text
if ($exported.DocumentElement.LocalName -cne 'Task') { throw 'Export is not task XML' }
$text | Set-Content -LiteralPath ${psq(file)} -Encoding Unicode -ErrorAction Stop
if ((Get-Item -LiteralPath ${psq(file)} -ErrorAction Stop).Length -le 0) { throw 'Task backup was not saved' }
[xml]$saved = Get-Content -LiteralPath ${psq(file)} -Raw -ErrorAction Stop
if ($saved.DocumentElement.LocalName -cne 'Task' -or $saved.OuterXml -cne $exported.OuterXml) { throw 'Task backup does not match exported task XML' }
Unregister-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath -Confirm:$false -ErrorAction Stop
if (Get-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath -ErrorAction SilentlyContinue) { throw 'Task is still registered' }
'OK'`;

// Only this deliberately narrow firewall subset can round-trip. Other rules
// remain in Windows, rather than restoring a broader or weaker policy later.
const FIREWALL_SNAPSHOT = `
function Assert-Default($object, $name, $allowed, $required = $false) {
  $property = $object.PSObject.Properties[$name]
  if ($null -eq $property -or $null -eq $property.Value -or @($property.Value).Count -eq 0) { if ($required) { throw "Missing required firewall filter: $name" }; return }
  foreach ($value in @($property.Value)) { if ([string]$value -notin $allowed) { throw "Unsupported firewall constraint: $name=$value. Leave this rule in Windows and manage it with Windows Firewall." } }
}
function One-Filter($filters) {
  $values = @($filters)
  if ($values.Count -ne 1) { throw 'Firewall filter identity is ambiguous' }
  return $values[0]
}
function Get-SafeFirewallSnapshot($r) {
  $a = One-Filter @($r | Get-NetFirewallApplicationFilter -ErrorAction Stop)
  $p = One-Filter @($r | Get-NetFirewallPortFilter -ErrorAction Stop)
  $address = One-Filter @($r | Get-NetFirewallAddressFilter -ErrorAction Stop)
  $service = One-Filter @($r | Get-NetFirewallServiceFilter -ErrorAction Stop)
  $interface = One-Filter @($r | Get-NetFirewallInterfaceFilter -ErrorAction Stop)
  $type = One-Filter @($r | Get-NetFirewallInterfaceTypeFilter -ErrorAction Stop)
  $security = One-Filter @($r | Get-NetFirewallSecurityFilter -ErrorAction Stop)
  Assert-Default $address 'LocalAddress' @('Any') $true; Assert-Default $address 'RemoteAddress' @('Any') $true
  Assert-Default $address 'RemoteDynamicKeywordAddresses' @('')
  Assert-Default $a 'Package' @('Any', '')
  Assert-Default $service 'Service' @('Any') $true
  Assert-Default $interface 'InterfaceAlias' @('Any') $true
  Assert-Default $type 'InterfaceType' @('Any') $true
  Assert-Default $security 'Authentication' @('NotRequired') $true; Assert-Default $security 'Encryption' @('NotRequired') $true
  foreach ($name in @('LocalUser', 'RemoteUser', 'RemoteMachine')) { Assert-Default $security $name @('Any', '') }
  Assert-Default $security 'OverrideBlockRules' @('False')
  Assert-Default $p 'IcmpType' @('Any'); Assert-Default $p 'DynamicTarget' @('Any')
  Assert-Default $r 'EdgeTraversalPolicy' @('Block')
  foreach ($name in @('LooseSourceMapping', 'LocalOnlyMapping')) { Assert-Default $r $name @('False') }
  foreach ($name in @('Platform', 'Owner', 'RemoteDynamicKeywordAddresses')) { Assert-Default $r $name @('') }
  Assert-Default $r 'PolicyStoreSourceType' @('Local')
  if ([string]$r.Direction -notin @('Inbound', 'Outbound') -or [string]$r.Action -notin @('Allow', 'Block') -or [string]$r.Enabled -notin @('True', 'False')) { throw 'Unsupported firewall rule state' }
  if ([string]$r.Profile -notmatch '^(Any|Domain|Private|Public)(, ?(Domain|Private|Public))*$') { throw 'Unsupported firewall profile' }
  if ([string]$p.Protocol -notin @('Any', 'TCP', 'UDP', '6', '17', '256')) { throw 'Unsupported firewall protocol' }
  foreach ($port in @($p.LocalPort) + @($p.RemotePort)) { if ([string]$port -notmatch '^(Any|[0-9]{1,5}(-[0-9]{1,5})?)$') { throw 'Unsupported firewall port constraint' } }
  if (-not $r.Name -or -not $r.DisplayName -or -not $a.Program -or -not @($p.LocalPort).Count -or -not @($p.RemotePort).Count) { throw 'Incomplete firewall filters' }
  [pscustomobject][ordered]@{ Schema = 'purgeon-firewall'; Version = 1; Name = [string]$r.Name; DisplayName = [string]$r.DisplayName; Description = [string]$r.Description; Group = [string]$r.Group; Direction = [string]$r.Direction; Action = [string]$r.Action; Profile = [string]$r.Profile; Enabled = [string]$r.Enabled; Program = [string]$a.Program; Protocol = [string]$p.Protocol; LocalPort = @($p.LocalPort | ForEach-Object { [string]$_ }); RemotePort = @($p.RemotePort | ForEach-Object { [string]$_ }) }
}
function Assert-SameSnapshot($actual, $expected) {
  if (($actual | ConvertTo-Json -Depth 5 -Compress) -cne ($expected | ConvertTo-Json -Depth 5 -Compress)) { throw 'Firewall backup or recreated rule does not match the original policy' }
}
`;

export const firewallRemovalScript = (target, file) => `
$ErrorActionPreference = 'Stop'
${FIREWALL_SNAPSHOT}
$rules = @(Get-NetFirewallRule -Name ${psq(target)} -ErrorAction Stop)
if (-not $rules.Count) { 'GONE'; return }
if ($rules.Count -ne 1 -or $rules[0].Name -cne ${psq(target)}) { throw 'Firewall rule identity is ambiguous' }
$r = $rules[0]
$snapshot = Get-SafeFirewallSnapshot $r
$snapshot | ConvertTo-Json -Depth 5 -Compress | Set-Content -LiteralPath ${psq(file)} -Encoding UTF8 -ErrorAction Stop
if ((Get-Item -LiteralPath ${psq(file)} -ErrorAction Stop).Length -le 0) { throw 'Firewall backup was not saved' }
$saved = Get-Content -LiteralPath ${psq(file)} -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
Assert-SameSnapshot $saved $snapshot
# Re-read immediately before deletion; do not delete a rule changed during export.
$fresh = @(Get-NetFirewallRule -Name ${psq(target)} -ErrorAction Stop)
if ($fresh.Count -ne 1) { throw 'Firewall rule changed during backup' }
Assert-SameSnapshot (Get-SafeFirewallSnapshot $fresh[0]) $snapshot
Remove-NetFirewallRule -Name $snapshot.Name -ErrorAction Stop
if (Get-NetFirewallRule -Name $snapshot.Name -ErrorAction SilentlyContinue) { throw 'Firewall rule is still present' }
'OK'`;

export const firewallRestoreScript = (target, file) => `
$ErrorActionPreference = 'Stop'
${FIREWALL_SNAPSHOT}
$r = Get-Content -LiteralPath ${psq(file)} -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
$fields = @('Schema','Version','Name','DisplayName','Description','Group','Direction','Action','Profile','Enabled','Program','Protocol','LocalPort','RemotePort')
if ($r.Schema -cne 'purgeon-firewall' -or $r.Version -ne 1 -or $r.Name -cne ${psq(target)} -or @($r.PSObject.Properties.Name).Count -ne $fields.Count) { throw 'This older or incomplete firewall backup cannot safely restore its original constraints. Review it in Windows Firewall.' }
foreach ($name in $fields) { if ($r.PSObject.Properties.Name -notcontains $name) { throw 'Incomplete firewall backup' } }
foreach ($name in @('Name','DisplayName','Direction','Action','Profile','Enabled','Program','Protocol')) { if ($r.$name -isnot [string] -or -not $r.$name) { throw 'Invalid firewall backup field' } }
foreach ($name in @('Description','Group')) { if ($r.$name -isnot [string]) { throw 'Invalid firewall metadata' } }
if ($r.Direction -notin @('Inbound','Outbound') -or $r.Action -notin @('Allow','Block') -or $r.Enabled -notin @('True','False') -or $r.Profile -notmatch '^(Any|Domain|Private|Public)(, ?(Domain|Private|Public))*$' -or $r.Protocol -notin @('Any','TCP','UDP','6','17','256')) { throw 'Invalid firewall backup policy' }
foreach ($name in @('LocalPort','RemotePort')) {
  if ($r.$name -isnot [array] -or -not $r.$name.Count) { throw 'Invalid firewall port array' }
  foreach ($port in $r.$name) { if ($port -isnot [string] -or $port -notmatch '^(Any|[0-9]{1,5}(-[0-9]{1,5})?)$') { throw 'Invalid firewall port' } }
}
if (Get-NetFirewallRule -Name $r.Name -ErrorAction SilentlyContinue) { throw 'A firewall rule with this name already exists; it was left unchanged' }
$created = $false
try {
  $params = @{ Name = $r.Name; DisplayName = $r.DisplayName; Description = $r.Description; Group = $r.Group; Direction = $r.Direction; Action = $r.Action; Enabled = 'False'; Profile = ($r.Profile -split ',\\s*'); Program = $r.Program; Protocol = $r.Protocol; LocalPort = $r.LocalPort; RemotePort = $r.RemotePort; ErrorAction = 'Stop' }
  $new = New-NetFirewallRule @params
  $created = $true
  $expected = $r | Select-Object *; $expected.Enabled = 'False'
  Assert-SameSnapshot (Get-SafeFirewallSnapshot $new) $expected
  if ($r.Enabled -eq 'True') { Set-NetFirewallRule -InputObject $new -Enabled True -ErrorAction Stop | Out-Null }
  $check = @(Get-NetFirewallRule -Name $r.Name -ErrorAction Stop)
  if ($check.Count -ne 1) { throw 'Recreated firewall identity is ambiguous' }
  Assert-SameSnapshot (Get-SafeFirewallSnapshot $check[0]) $r
  'OK'
} catch {
  $failure = $_
  if ($created) { Remove-NetFirewallRule -InputObject $new -ErrorAction Stop }
  throw $failure
}`;
