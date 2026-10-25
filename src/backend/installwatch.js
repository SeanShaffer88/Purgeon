// Spots installers as they start, so Purgeon can offer to monitor them. Only new processes
// in your own Windows session count (never services or Windows' own servicing), and only ones
// named like an installer, or Windows Installer (msiexec) opening an .msi package. Nothing is
// recorded unless you say yes; most installers wait on their first page, which leaves time for
// the "before" snapshot.
import { sys } from './sys.js';
import { runPSJson } from './shell.js';

const LOOKS_LIKE_INSTALLER = /setup|install/i;
// Uninstallers, updaters' helpers and Windows' own installer processes.
const NOT_AN_INSTALLER = /unins|uninst|^(TrustedInstaller|InstallAgent|InstallAgentUserBroker|SetupHost|SetupPrep|SetupPlatform|DismHost|TiWorker|MsiExecUI|InstallShieldHelper)\.exe$/i;

export function looksLikeInstaller(name) {
  return /\.(exe|tmp)$/i.test(name) && LOOKS_LIKE_INSTALLER.test(name) && !NOT_AN_INSTALLER.test(name);
}

let seen = null;
let mySession = null;
let myPid = null;
const found = new Set();

// New installer processes since the last call: [{ pid, name, path, company }]. The first call
// only learns what is already running.
export async function check() {
  if (!sys.listProcesses) return [];
  const list = await sys.listProcesses();
  if (!seen) {
    seen = new Set(list.map((p) => p.pid));
    const me = list.find((p) => /^purgeon/i.test(p.name));
    mySession = me?.session ?? null;
    myPid = me?.pid ?? null;
    return [];
  }
  const fresh = list.filter((p) => !seen.has(p.pid));
  seen = new Set(list.map((p) => p.pid));
  for (const pid of [...found]) if (!seen.has(pid)) found.delete(pid);
  const candidates = fresh.filter(
    (p) =>
      p.session !== 0 &&
      (mySession === null || p.session === mySession) &&
      p.ppid !== myPid &&
      // A setup's own helper processes belong to the installation already found.
      !found.has(p.ppid) &&
      (looksLikeInstaller(p.name) || /^msiexec\.exe$/i.test(p.name))
  );
  if (!candidates.length) return [];
  const details = await runPSJson(
    `$ids = [Console]::In.ReadToEnd() | ConvertFrom-Json
     $out = foreach ($id in @($ids)) {
       $p = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue
       if (-not $p) { continue }
       $vi = $null
       if ($p.ExecutablePath) { $vi = (Get-Item -LiteralPath $p.ExecutablePath -ErrorAction SilentlyContinue).VersionInfo }
       [pscustomobject]@{ pid = [int]$p.ProcessId; path = [string]$p.ExecutablePath; cmd = [string]$p.CommandLine; product = [string]$vi.ProductName; description = [string]$vi.FileDescription; company = [string]$vi.CompanyName }
     }
     ConvertTo-Json -InputObject @($out) -Compress`,
    { input: JSON.stringify(candidates.map((p) => p.pid)) }
  ).catch(() => []);
  const out = [];
  for (const d of details) {
    if (/^[a-z]:\\windows\\(?!temp\\)/i.test(d.path) && !/msiexec\.exe$/i.test(d.path)) continue;
    let name;
    let file = d.path;
    if (/msiexec\.exe$/i.test(d.path)) {
      // Only msiexec opening a package; the Windows Installer service itself also runs as msiexec.
      const msi = d.cmd.match(/\/(?:i|package)\s+"?([^"]+?\.msi)"?(\s|$)/i);
      if (!msi) continue;
      file = msi[1];
      name = file.split('\\').pop().replace(/\.msi$/i, '');
    } else {
      name = (d.product || d.description || d.path.split('\\').pop()).replace(/\s+(setup|installer)$/i, '').trim();
    }
    found.add(d.pid);
    out.push({ pid: d.pid, name, path: file, company: d.company });
  }
  return out;
}
