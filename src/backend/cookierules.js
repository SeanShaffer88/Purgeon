// Per-site cookie rules (inside Browser Clean-up): sites that may never
// set cookies, and sites that always may, written to Chrome's and Edge's
// own policy keys — the mechanism both browsers document for exactly
// this. The same list is mirrored to both browsers, and the window says
// so. Firefox does not read these policies; the window says that too,
// rather than pretending the rules cover it.
//
// Policy shape: under each browser's key, CookiesBlockedForUrls and
// CookiesAllowedForUrls are subkeys whose numbered values ("1", "2", ...)
// are site patterns like "example.com" or "[*.]example.com".
import { runPS, runPSJson } from './shell.js';
import { record } from './history.js';

const note = (entry) => record(entry).catch(() => {});
const BROWSERS = ['HKLM\\SOFTWARE\\Policies\\Google\\Chrome', 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge'];
const KINDS = { blocked: 'CookiesBlockedForUrls', allowed: 'CookiesAllowedForUrls' };

export function nextIndex(names) {
  const nums = (names || []).map((n) => Number.parseInt(n, 10)).filter((n) => Number.isInteger(n) && n > 0);
  return nums.length ? Math.max(...nums) + 1 : 1;
}

const PATTERN_RE = /^(\[\*\.\])?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

export function cleanPattern(input) {
  let p = String(input || '').trim().toLowerCase();
  p = p.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!PATTERN_RE.test(p)) return null;
  return p;
}

async function readKind(subkey) {
  const rows = await runPSJson(`$out = @()
foreach ($root in @('${BROWSERS[0]}', '${BROWSERS[1]}')) {
  $k = Join-Path $root '${subkey}'
  if (Test-Path $k) {
    $props = Get-ItemProperty $k
    foreach ($p in $props.PSObject.Properties) {
      if ($p.Name -match '^\\d+$') { $out += [pscustomobject]@{ root = $root; n = $p.Name; pattern = [string]$p.Value } }
    }
  }
}
$out | ConvertTo-Json -Compress`).catch(() => []);
  return Array.isArray(rows) ? rows : [rows];
}

// One list per kind: the union of both browsers' patterns (they are kept
// mirrored, so the union is the list; a pattern missing from one browser
// is re-mirrored on the next change).
export async function rules() {
  const out = {};
  for (const [kind, subkey] of Object.entries(KINDS)) {
    const rows = await readKind(subkey);
    out[kind] = [...new Set(rows.filter(Boolean).map((r) => r.pattern))].sort();
  }
  return out;
}

const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

export async function addRule(kind, rawPattern) {
  const subkey = KINDS[kind];
  if (!subkey) throw new Error('Unknown rule kind.');
  const pattern = cleanPattern(rawPattern);
  if (!pattern) throw new Error('That does not look like a site address. Use a form like example.com or [*.]example.com for a site and everything under it.');
  for (const root of BROWSERS) {
    const rows = (await readKind(subkey)).filter((r) => r && r.root === root);
    if (rows.some((r) => r.pattern === pattern)) continue;
    const n = nextIndex(rows.map((r) => r.n));
    await runPS(`New-Item -Path ${psQuote(`${root}\\${subkey}`)} -Force | Out-Null
New-ItemProperty -Path ${psQuote(`${root}\\${subkey}`)} -Name '${n}' -Value ${psQuote(pattern)} -PropertyType String -Force | Out-Null`);
  }
  note({
    type: 'Cookie rule', title: `${kind === 'blocked' ? 'Blocked' : 'Allowed'} cookies for ${pattern}`,
    detail: 'Written to the Chrome and Edge policy keys, so it holds in every profile and while the browsers run. Firefox does not read these policies.',
    undo: { channel: 'cookies:removeRule', arg: { kind, pattern } },
  });
  return { ok: true, pattern };
}

export async function removeRule(kind, pattern) {
  const subkey = KINDS[kind];
  if (!subkey) throw new Error('Unknown rule kind.');
  for (const root of BROWSERS) {
    await runPS(`$k = ${psQuote(`${root}\\${subkey}`)}
if (Test-Path $k) {
  $props = Get-ItemProperty $k
  foreach ($p in $props.PSObject.Properties) {
    if ($p.Name -match '^\\d+$' -and [string]$p.Value -eq ${psQuote(pattern)}) { Remove-ItemProperty -Path $k -Name $p.Name }
  }
}`);
  }
  note({
    type: 'Cookie rule', title: `Removed the ${kind} cookie rule for ${pattern}`,
    detail: 'Chrome and Edge go back to their normal cookie behaviour for this site.',
    undo: { channel: 'cookies:addRule', arg: { kind, pattern } },
  });
  return { ok: true };
}
