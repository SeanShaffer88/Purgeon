// Fills in size and install date for programs whose registry entry leaves them out,
// by measuring the program's own folder.
const fs = require('fs');
const path = require('path');
const { iconPathFor } = require('./programs.cjs');
const { fileRoots, isProtected } = require('./paths.cjs');

// Folders that hold installers or shared files rather than one program.
const NOT_A_PROGRAM_FOLDER = /\\(package cache|installer\d*|windowsapps|common files|temp)(\\|$)/i;

const under = (child, parent) => child.toLowerCase().startsWith(parent.toLowerCase().replace(/\\+$/, '') + '\\');

// The program's folder: its InstallLocation, or else the folder of its icon exe when
// that sits in its own folder under an install root.
function programFolder(p) {
  const clean = (s) => (s || '').replace(/^"|"$/g, '').trim().replace(/\\+$/, '');
  const location = clean(p.location);
  if (location && !isProtected(location) && !NOT_A_PROGRAM_FOLDER.test(location) && fs.existsSync(location)) return { dir: location, source: 'install folder' };
  const exe = iconPathFor(p);
  if (!exe) return null;
  const dir = path.dirname(exe);
  if (isProtected(dir) || NOT_A_PROGRAM_FOLDER.test(dir) || !fileRoots().some((r) => under(dir, r)) || !fs.existsSync(dir)) return null;
  return { dir, source: 'program folder' };
}

// Total size of a folder, skipping links and stopping at a time and entry budget.
async function folderSize(dir, { maxEntries = 300000, maxMs = 15000 } = {}) {
  const started = Date.now();
  let bytes = 0;
  let entries = 0;
  let truncated = false;
  const stack = [dir];
  while (stack.length) {
    if (entries > maxEntries || Date.now() - started > maxMs) {
      truncated = true;
      break;
    }
    const current = stack.pop();
    let handle;
    try {
      handle = await fs.promises.opendir(current);
    } catch {
      continue;
    }
    for await (const e of handle) {
      entries++;
      const full = path.join(current, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) {
        try {
          bytes += (await fs.promises.stat(full)).size;
        } catch {}
      }
    }
  }
  return { bytes, entries, truncated };
}

const isoDate = (d) => (d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : '');

async function measureOne(p) {
  const folder = programFolder(p);
  if (!folder) return { key: p.key };
  const out = { key: p.key, folder: folder.dir };
  if (!p.sizeKB) {
    const { bytes, truncated } = await folderSize(folder.dir);
    if (bytes > 0) Object.assign(out, { sizeKB: Math.round(bytes / 1024), sizeMeasured: true, sizeTruncated: truncated });
  }
  if (!p.installDate) {
    try {
      const st = await fs.promises.stat(folder.dir);
      const date = isoDate(st.birthtime.getTime() > 0 ? st.birthtime : st.mtime);
      if (date) Object.assign(out, { installDate: date, dateMeasured: true });
    } catch {}
  }
  return out;
}

// Measures a few programs at a time; `onResult` gets each result as soon as it's ready.
async function measure(programs, onResult) {
  const queue = programs.filter((p) => !p.store && (!p.sizeKB || !p.installDate));
  const worker = async () => {
    while (queue.length) {
      const result = await measureOne(queue.shift()).catch(() => null);
      if (result && (result.sizeKB || result.installDate)) onResult(result);
    }
  };
  await Promise.all(Array.from({ length: 3 }, worker));
}

module.exports = { measure, measureOne, programFolder, folderSize };
