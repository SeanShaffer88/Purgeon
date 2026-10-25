// Program insights shown as tags in the program list:
// - whether each program's main file is digitally signed, and by whom;
// - programs installed (or updated) together with a program from another publisher, which is
//   how bundled offers usually arrive, and names typical of bundled offers;
// - size history, to spot programs that keep growing.
import { sys } from './sys.js';
import * as path from './winpath.js';
import { runPSJson } from './shell.js';
import { iconPathFor } from './programs.js';
import { publisherKey } from './leftovers.js';

let dir = '';
export const setRoot = async (d) => {
  dir = d;
  await sys.makeDir(dir);
};

// ---- signatures --------------------------------------------------------------------

const SIGNATURES = `
$in = [Console]::In.ReadToEnd() | ConvertFrom-Json  # assigned first so the array is unrolled
@(foreach ($p in $in) {
  if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { continue }
  $s = Get-AuthenticodeSignature -LiteralPath $p -ErrorAction SilentlyContinue
  if (-not $s) { continue }
  $cn = if ($s.SignerCertificate -and $s.SignerCertificate.Subject -match 'CN="?([^,"]+)') { $matches[1] } else { '' }
  [pscustomobject]@{ path = [string]$p; status = [string]$s.Status; signer = $cn }
}) | ConvertTo-Json -Compress
`;

// Signature of each file: Map(lowercased path -> { status: 'Valid' | 'NotSigned' | 'HashMismatch' | ..., signer }).
export async function signatures(paths) {
  const unique = [...new Set(paths.filter((p) => /^[a-z]:\\.+\.(exe|dll|sys)$/i.test(p || '')))];
  if (!unique.length) return new Map();
  const rows = await runPSJson(SIGNATURES, { input: JSON.stringify(unique) }).catch(() => []);
  return new Map(rows.map((r) => [r.path.toLowerCase(), { status: r.status, signer: r.signer }]));
}

const HELPER_EXE = /(^|\\)(unins\d*|uninst\w*|uninstall\w*|setup|update\w*|helper|crashpad\w*|elevate\w*)\.exe$/i;

// The program's own executable, when its uninstall entry names one (not an uninstaller, and not in
// Windows Installer's cache).
export function mainExe(p) {
  const f = iconPathFor(p);
  return f && /\.exe$/i.test(f) && !/\\Windows\\Installer\\/i.test(f) && !HELPER_EXE.test(f) ? f : null;
}

// Otherwise the largest program file directly in its install folder.
async function exeInFolder(p) {
  const loc = String(p.location || '').replace(/^"|"$/g, '').trim();
  if (!/^[a-z]:\\.+/i.test(loc)) return null;
  const files = (await sys.readDir(loc).catch(() => [])).filter((e) => e.file && /\.exe$/i.test(e.name) && !HELPER_EXE.test(e.name));
  let best = null;
  for (const e of files.slice(0, 40)) {
    const full = path.join(loc, e.name);
    const s = await sys.stat(full).catch(() => null);
    if (s && (!best || s.size > best.size)) best = { full, size: s.size };
  }
  return best?.full || null;
}

// ---- bundled offers ----------------------------------------------------------------

// Words typical of programs that arrive as bundled offers (toolbars, "optimizers", search helpers).
const OFFER_PATTERNS = [
  /\btoolbar\b/i,
  /\bsearch ?(protect|helper|assistant|bar|manager|app)\b/i,
  /\b(pc|registry|system|speed) ?(optimi[sz]er|cleaner|booster|fixer|mechanic|doctor|speedup)\b/i,
  /\bdriver ?(updater|booster|easy|support)\b/i,
  /\bbrowser ?(assistant|helper|guard)\b/i,
  /\b(coupon|shopping|price) ?(assistant|helper|finder|alert)\b/i,
  /\bweb ?companion\b/i,
  /\bnew ?tab\b/i,
];
export const looksLikeOffer = (name) => OFFER_PATTERNS.some((re) => re.test(name || ''));

// Runtimes and framework updates are installed alongside many programs; they are not offers.
const RUNTIME = /visual c\+\+|\.net|asp\.net|windows desktop runtime|webview2|directx|redistributable|runtime|sdk|driver|chipset/i;
const WINDOW_MS = 2 * 60 * 1000;

// Programs written to the registry within two minutes of a program from another publisher.
export function installedTogether(programs, times) {
  const out = new Map();
  const timed = programs
    .filter((p) => !RUNTIME.test(p.name) && times[p.key])
    .map((p) => ({ p, t: times[p.key], pub: publisherKey(p.publisher) }));
  for (const a of timed) {
    const mates = timed.filter((b) => b !== a && Math.abs(b.t - a.t) <= WINDOW_MS && (!a.pub || !b.pub || b.pub !== a.pub));
    if (mates.length && mates.length <= 4) out.set(a.p.key, mates.map((m) => m.p.name));
  }
  return out;
}

// ---- size history ------------------------------------------------------------------

const sizesFile = () => path.join(dir, 'sizes.json');
const today = () => new Date().toISOString().slice(0, 10);

// Records each program's size once a day (KB), keeping a year of history.
export async function recordSizes(programs, day = today()) {
  const all = await sys.readText(sizesFile()).then(JSON.parse).catch(() => ({}));
  for (const p of programs) {
    const kb = Math.round(Number(p.sizeKB) || 0);
    if (!kb) continue;
    const h = (all[p.key] = all[p.key] || []);
    if (h.length && h[h.length - 1][0] === day) h[h.length - 1][1] = kb;
    else h.push([day, kb]);
    if (h.length > 365) h.splice(0, h.length - 365);
  }
  await sys.writeText(sizesFile(), JSON.stringify(all));
  return all;
}

export const sizeHistory = async () => sys.readText(sizesFile()).then(JSON.parse).catch(() => ({}));

// Grew by at least a fifth and 50 MB over the last 90 days of history.
export function growth(history, day = today()) {
  if (!history || history.length < 2) return null;
  const since = new Date(new Date(day).getTime() - 90 * 86400000).toISOString().slice(0, 10);
  const base = history.find(([d]) => d >= since) || history[0];
  const last = history[history.length - 1];
  if (base === last) return null;
  const grew = last[1] - base[1];
  return grew >= 51200 && last[1] >= base[1] * 1.2 ? { fromKB: base[1], toKB: last[1], since: base[0] } : null;
}

// ---- all together ------------------------------------------------------------------

// The program's main executable: the one its entry names, or the largest in its folder.
export const programExe = async (p) => mainExe(p) || (await exeInFolder(p));

// The processor each file is built for ("x64", "x86", "arm64"), read from its header.
async function architectures(paths) {
  if (!sys.exeArch || !paths.length) return new Map();
  const out = await sys.exeArch(paths).catch(() => []);
  return new Map(paths.map((p, i) => [p.toLowerCase(), out[i] || '']));
}

// { [programKey]: { signature?, signer?, together?: [names], offer?: true, growth?, arch?, exe? } }
export async function programInsights(programs) {
  const exes = new Map(await Promise.all(programs.map(async (p) => [p.key, await programExe(p)])));
  const [sigs, times, sizes, archs] = await Promise.all([
    signatures([...exes.values()].filter(Boolean)),
    sys.uninstallKeyTimes ? sys.uninstallKeyTimes().catch(() => ({})) : {},
    recordSizes(programs).catch(() => ({})),
    architectures([...exes.values()].filter(Boolean)),
  ]);
  const together = installedTogether(programs, times);
  const out = {};
  for (const p of programs) {
    const sig = exes.get(p.key) && sigs.get(exes.get(p.key).toLowerCase());
    const g = growth(sizes[p.key]);
    const info = {
      ...(sig && { signature: sig.status, signer: sig.signer }),
      ...(together.has(p.key) && { together: together.get(p.key) }),
      ...(looksLikeOffer(p.name) && { offer: true }),
      ...(g && { growth: g }),
      ...(times[p.key] && { written: times[p.key] }),
      ...(exes.get(p.key) && archs.get(exes.get(p.key).toLowerCase()) && { arch: archs.get(exes.get(p.key).toLowerCase()), exe: exes.get(p.key) }),
    };
    if (Object.keys(info).length) out[p.key] = info;
  }
  return out;
}
