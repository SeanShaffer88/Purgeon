// A Node.js version of the system layer (src/backend/sys.js) so the backend logic can be
// tested, and scripted, outside the app. It mirrors the Rust core in src-tauri/src/lib.rs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';

const run = (file, args, input) =>
  new Promise((resolve) => {
    const child = execFile(file, args, { maxBuffer: 512 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) =>
      resolve({ ok: !err, code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout, stderr: stderr || (err && !stderr ? err.message : '') })
    );
    if (input !== undefined && input !== null) child.stdin.write(input);
    child.stdin.end();
  });

function folderSize(dir, maxEntries, maxMs) {
  const start = Date.now();
  let bytes = 0;
  let entries = 0;
  let truncated = false;
  const stack = [dir];
  while (stack.length) {
    if (entries > maxEntries || Date.now() - start > maxMs) {
      truncated = true;
      break;
    }
    let list = [];
    try {
      list = fs.readdirSync(stack.pop(), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of list) {
      entries++;
      const full = path.join(e.parentPath ?? e.path, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) bytes += fs.statSync(full, { throwIfNoEntry: false })?.size || 0;
    }
  }
  return { bytes, entries, truncated };
}

export function createNodeSys(dataDir = path.join(os.tmpdir(), 'sweepuninstall-test-data')) {
  return {
    info: { env: { ...process.env }, home: os.homedir(), dataDir, exe: process.execPath },
    async runPS(script, input) {
      const wrapped = `$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.Encoding]::UTF8;${script}`;
      const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(wrapped, 'utf16le').toString('base64')], input ?? '');
      if (!r.ok) throw new Error(r.stderr || `PowerShell exited with ${r.code}`);
      return r.stdout;
    },
    exec: (file, args) => run(file, args),
    runCommandLine: (commandLine) =>
      new Promise((resolve) => {
        const child = spawn(commandLine, { shell: true, windowsHide: true });
        child.on('error', (e) => resolve({ ok: false, code: -1, stderr: e.message }));
        child.on('exit', (code) => resolve({ ok: code === 0, code, stderr: '' }));
      }),
    launch: async (file, args = []) => {
      spawn(file, args, { detached: true, stdio: 'ignore' }).unref();
    },
    readDir: async (p) => {
      try {
        return fs.readdirSync(p, { withFileTypes: true }).map((e) => ({ name: e.name, dir: e.isDirectory(), file: e.isFile(), link: e.isSymbolicLink() }));
      } catch {
        return [];
      }
    },
    stat: async (p) => {
      const s = fs.statSync(p, { throwIfNoEntry: false });
      return s ? { size: s.size, dir: s.isDirectory(), created: s.birthtimeMs, modified: s.mtimeMs } : null;
    },
    exists: async (p) => fs.existsSync(p),
    readText: async (p) => fs.readFileSync(p, 'utf8'),
    writeText: async (p, s) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, s);
    },
    makeDir: async (p) => {
      fs.mkdirSync(p, { recursive: true });
    },
    removePath: async (p) => fs.rmSync(p, { recursive: true, force: true }),
    // Tests never use the Recycle Bin; scripts that need it pass their own trashItem.
    trash: async () => {
      throw new Error('trash is not available outside the app');
    },
    walk: async (roots, maxDirDepth, maxFileDepth) => {
      const out = [];
      const go = (dir, depth) => {
        let list = [];
        try {
          list = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of list) {
          if (e.isSymbolicLink()) continue;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) {
            out.push('D' + full);
            if (depth < maxDirDepth) go(full, depth + 1);
          } else if (e.isFile() && depth <= maxFileDepth) out.push('F' + full);
        }
      };
      for (const r of roots) go(r, 1);
      return out;
    },
    folderSize: async (p, maxEntries, maxMs) => folderSize(p, maxEntries, maxMs),
    quit: async () => {},
  };
}
