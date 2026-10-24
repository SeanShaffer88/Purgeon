// Thin wrappers around PowerShell and reg.exe.
const { execFile, spawn } = require('child_process');

function runPS(script, { input } = {}) {
  return new Promise((resolve, reject) => {
    const wrapped = `$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.Encoding]::UTF8;${script}`;
    const encoded = Buffer.from(wrapped, 'utf16le').toString('base64');
    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { maxBuffer: 512 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        resolve(stdout);
      }
    );
    if (input !== undefined) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}

async function runPSJson(script, opts) {
  const out = (await runPS(script, opts)).trim();
  if (!out) return [];
  const parsed = JSON.parse(out);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function reg(args) {
  return new Promise((resolve) => {
    execFile('reg.exe', args, { windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout, stderr: stderr || (err && err.message) || '' });
    });
  });
}

// Runs an uninstall command line as written in the registry and waits for it to exit.
function runCommandLine(commandLine) {
  return new Promise((resolve) => {
    const child = spawn(commandLine, { shell: true, windowsHide: false, detached: false });
    child.on('error', (e) => resolve({ ok: false, code: -1, error: e.message }));
    child.on('exit', (code) => resolve({ ok: code === 0, code }));
  });
}

// Wraps a value for a PowerShell single-quoted string literal.
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;

module.exports = { runPS, runPSJson, reg, runCommandLine, psq };
