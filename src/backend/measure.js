// Fills in size and install date for programs whose registry entry leaves them out,
// by measuring the program's own folder.
import { sys } from './sys.js';
import * as path from './winpath.js';
import { iconPathFor } from './programs.js';
import { fileRoots, isProtected } from './paths.js';

// Folders that hold installers or shared files rather than one program.
const NOT_A_PROGRAM_FOLDER = /\\(package cache|installer\d*|windowsapps|common files|temp)(\\|$)/i;

const under = (child, parent) => child.toLowerCase().startsWith(parent.toLowerCase().replace(/\\+$/, '') + '\\');

// The program's folder: its InstallLocation, or else the folder of its icon exe when
// that sits in its own folder under an install root.
async function programFolder(p) {
  const clean = (s) => (s || '').replace(/^"|"$/g, '').trim().replace(/\\+$/, '');
  const location = clean(p.location);
  if (location && !isProtected(location) && !NOT_A_PROGRAM_FOLDER.test(location) && (await sys.exists(location))) return { dir: location, source: 'install folder' };
  const exe = iconPathFor(p);
  if (!exe) return null;
  const dir = path.dirname(exe);
  if (isProtected(dir) || NOT_A_PROGRAM_FOLDER.test(dir) || !fileRoots().some((r) => under(dir, r)) || !(await sys.exists(dir))) return null;
  return { dir, source: 'program folder' };
}

// Total size of a folder (walked natively), skipping links, within a time and entry budget.
const folderSize = (dir, { maxEntries = 300000, maxMs = 15000 } = {}) => sys.folderSize(dir, maxEntries, maxMs);

const isoDate = (ms) => (ms > 0 ? new Date(ms).toISOString().slice(0, 10) : '');

async function measureOne(p) {
  const folder = await programFolder(p);
  if (!folder) return { key: p.key };
  const out = { key: p.key, folder: folder.dir };
  if (!p.sizeKB) {
    const { bytes, truncated } = await folderSize(folder.dir);
    if (bytes > 0) Object.assign(out, { sizeKB: Math.round(bytes / 1024), sizeMeasured: true, sizeTruncated: truncated });
  }
  if (!p.installDate) {
    const st = await sys.stat(folder.dir).catch(() => null);
    const date = st ? isoDate(st.created > 0 ? st.created : st.modified) : '';
    if (date) Object.assign(out, { installDate: date, dateMeasured: true });
  }
  return out;
}

// Measures a few programs at a time; `onResult` gets each result as soon as it's ready.
// `shouldStop` is polled between programs so the sweep can be cancelled.
async function measure(programs, onResult, shouldStop) {
  const queue = programs.filter((p) => !p.store && (!p.sizeKB || !p.installDate));
  const worker = async () => {
    while (queue.length) {
      if (shouldStop && shouldStop()) return;
      const result = await measureOne(queue.shift()).catch(() => null);
      if (result && (result.sizeKB || result.installDate)) onResult(result);
    }
  };
  await Promise.all(Array.from({ length: 3 }, worker));
}

export { measure, measureOne, programFolder, folderSize };
