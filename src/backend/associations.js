// File association / extension ownership lookup. Reads HKEY_CLASSES_ROOT to tell the user which
// program owns a file extension, and which extensions a program owns — useful for identifying
// mystery file types left behind after an uninstall.
import { runPSJson } from './shell.js';

// All file extensions registered under HKEY_CLASSES_ROOT and the program (ProgID) that owns them.
export async function extensions() {
  const script = `
$out = @()
foreach ($ext in (Get-ChildItem 'HKCR:\\' -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^HKCR:\\\\\\.' })) {
  $progid = ''
  try { $progid = [string](Get-ItemProperty -LiteralPath $ext.PSPath -Name '(default)' -ErrorAction SilentlyContinue).'(default)' } catch {}
  if (-not $progid) { continue }
  $exe = ''
  try { $exe = [string](Get-ItemProperty -LiteralPath "HKCR:\\$progid\\shell\\open\\command" -Name '(default)' -ErrorAction SilentlyContinue).'(default)' } catch {}
  $exe = $exe -replace '"','' -replace ' .*',''
  [pscustomobject]@{ extension = $ext.PSChildName; progid = $progid; exe = $exe }
  $out += $_
}
$out | ConvertTo-Json -Compress -Depth 3
`;
  return runPSJson(script);
}

// Which program owns a given extension (e.g. '.vcproj').
export async function ownerFor(extension) {
  const ext = extension.startsWith('.') ? extension : `.${extension}`;
  const list = await extensions();
  return list.find((e) => e.extension.toLowerCase() === ext.toLowerCase()) || null;
}

// All extensions owned by a program (matched by exe path or name).
export async function extensionsForProgram(nameOrExe) {
  const list = await extensions();
  const needle = String(nameOrExe).toLowerCase();
  return list.filter((e) => e.exe.toLowerCase().includes(needle) || e.progid.toLowerCase().includes(needle));
}
