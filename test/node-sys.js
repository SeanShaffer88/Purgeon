// A Node.js version of the system layer (src/backend/sys.js) so the backend logic can be
// tested, and scripted, outside the app. It mirrors the Rust core in src-tauri/src/lib.rs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';

// Like the Rust core, without a PSModulePath inherited from PowerShell 7.
const { PSModulePath, ...childEnv } = process.env;
const run = (file, args, input) =>
  new Promise((resolve) => {
    const child = execFile(file, args, { maxBuffer: 512 * 1024 * 1024, windowsHide: true, env: childEnv }, (err, stdout, stderr) =>
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

export function createNodeSys(dataDir = path.join(os.tmpdir(), 'purgeon-test-data')) {
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
    // A faithful local stand-in for the native secure erase: overwrite the
    // file's full length per pass, then delete it. Links are refused.
    secureErase: async (p, passes) => {
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) throw new Error('Links are not erased — erase the real file instead');
      if (!st.isFile()) throw new Error('Not a file');
      const len = st.size;
      const fd = fs.openSync(p, 'r+');
      try {
        for (const pass of passes) {
          const buf = Buffer.alloc(Math.min(len, 1 << 20));
          if (pass === 'random') for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
          let written = 0;
          while (written < len) {
            const n = Math.min(buf.length, len - written);
            fs.writeSync(fd, buf, 0, n, written);
            written += n;
          }
          fs.fsyncSync(fd);
        }
      } finally {
        fs.closeSync(fd);
      }
      fs.unlinkSync(p);
    },
    cancelErase: async () => {},
    writeTextAtomic: async (p, s) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const tmp = `${p}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, s);
      // Mirror the native command: on Windows the rename can fail with
      // EPERM while another process holds the target open for a moment
      // (test files share one data folder), so retry briefly.
      let lastErr = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        try {
          fs.renameSync(tmp, p);
          return;
        } catch (e) {
          lastErr = e;
          if (attempt < 5) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
        }
      }
      throw lastErr;
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
    listJunk: async (root) => listJunk(root),
    sha256Files: async (paths) => paths.map((p) => { try { return createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return ''; } }),
    appendText: async (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.appendFileSync(p, s); },
    quit: async () => {},
  };
}

// Items directly inside a folder with their total size and newest modification time (like list_junk in lib.rs).
function listJunk(root) {
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => !e.isSymbolicLink())
    .map((e) => {
      const full = path.join(root, e.name);
      let bytes = 0;
      let newest = fs.statSync(full).mtimeMs;
      const visit = (p) => {
        for (const c of fs.readdirSync(p, { withFileTypes: true })) {
          const cp = path.join(p, c.name);
          const s = fs.statSync(cp);
          newest = Math.max(newest, s.mtimeMs);
          if (c.isDirectory()) visit(cp);
          else bytes += s.size;
        }
      };
      if (e.isDirectory()) visit(full);
      else bytes = fs.statSync(full).size;
      return { path: full, dir: e.isDirectory(), bytes, newest };
    });
}