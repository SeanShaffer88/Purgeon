// PowerShell, reg.exe and uninstall command lines, through the system layer.
import { sys } from './sys.js';

export async function runPS(script, { input, timeout = 60000 } = {}) {
  try {
    return await sys.runPS(script, input, timeout);
  } catch (e) {
    throw new Error(typeof e === 'string' ? e : e?.message || String(e));
  }
}

export async function runPSJson(script, opts) {
  const out = (await runPS(script, opts)).trim();
  if (!out) return [];
  const parsed = JSON.parse(out);
  return Array.isArray(parsed) ? parsed : [parsed];
}

export async function reg(args) {
  const r = await sys.exec('reg.exe', args);
  return { ok: r.ok, stdout: r.stdout, stderr: r.stderr || (r.ok ? '' : `reg.exe exited with code ${r.code}`) };
}

// Runs a program directly; resolves to { ok, out } with stdout or the error text.
export async function execFile(file, args) {
  const r = await sys.exec(file, args);
  return { ok: r.ok, out: (r.stdout || '') + (r.ok ? '' : r.stderr || '') };
}

// Runs an uninstall command line as written in the registry and waits for it to exit.
export async function runCommandLine(commandLine) {
  const r = await sys.runCommandLine(commandLine);
  return r.code === -1 && r.stderr ? { ok: false, code: -1, error: r.stderr } : { ok: r.ok, code: r.code };
}

// Wraps a value for a PowerShell single-quoted string literal.
export const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;
