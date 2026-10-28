// Secure Erase (Tools › Advanced Tools): overwrite files, then delete them.
// Deliberately narrow — files only (folders are expanded into their files
// first), never registry items, never protected paths, and no backup is
// taken: erasing without a safety net is the point of the tool, so the
// window makes the user review the exact list and confirm every time.
import { sys } from './sys.js';
import * as path from './winpath.js';
import { isProtected } from './paths.js';

// The overwrite patterns the window offers, as pass lists for the native
// secure_erase_file command.
export const PATTERNS = {
  zero: { label: '1 pass · zeros', passes: ['zero'] },
  random: { label: '1 pass · random', passes: ['random'] },
  three: { label: '3 passes', passes: ['zero', 'random', 'zero'] },
};

const MAX_FILES = 10000;

// Expands the chosen paths into the flat file list to erase. Folders are
// walked (links are listed as refusals, never followed); protected paths
// and missing paths come back as refusals with the reason, so the window
// can show exactly what will and will not happen before anything runs.
export async function collect(paths) {
  const files = [];
  const refused = [];
  const seen = new Set();
  const addFile = async (p) => {
    const key = p.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    if (isProtected(p)) {
      refused.push({ path: p, reason: 'Protected Windows location — never erased' });
      return;
    }
    const st = await sys.stat(p).catch(() => null);
    if (!st) {
      refused.push({ path: p, reason: 'No longer there' });
      return;
    }
    files.push({ path: p, size: st.size || 0 });
  };
  const walk = async (dir) => {
    if (files.length + refused.length >= MAX_FILES) return;
    const entries = await sys.readDir(dir).catch(() => []);
    for (const e of entries) {
      if (files.length + refused.length >= MAX_FILES) return;
      const full = path.join(dir, e.name);
      if (e.link) refused.push({ path: full, reason: 'A link — erase the real file instead' });
      else if (e.dir) await walk(full);
      else if (e.file) await addFile(full);
    }
  };
  for (const p of paths || []) {
    if (isProtected(p)) {
      refused.push({ path: p, reason: 'Protected Windows location — never erased' });
      continue;
    }
    const st = await sys.stat(p).catch(() => null);
    if (!st) {
      refused.push({ path: p, reason: 'No longer there' });
    } else if (st.dir) {
      if (isProtected(p)) refused.push({ path: p, reason: 'Protected Windows location — never erased' });
      else await walk(p);
    } else {
      await addFile(p);
    }
  }
  return { files, refused };
}

// Erases the files one by one. `shouldStop` is polled between files; the
// native command also takes a cancel (sys.cancelErase) for the file in
// progress. A native "cancelled" error, or the stop flag, ends the run with
// the remaining files reported as left in place.
export async function erase({ files, pattern, shouldStop, onProgress }) {
  const spec = PATTERNS[pattern] || PATTERNS.zero;
  const results = [];
  let stopped = false;
  for (const [i, f] of (files || []).entries()) {
    if (stopped || (shouldStop && shouldStop())) {
      stopped = true;
      results.push({ path: f.path, ok: false, detail: 'Left in place — the erase was cancelled' });
      continue;
    }
    try {
      await sys.secureErase(f.path, spec.passes);
      results.push({ path: f.path, ok: true, detail: `Overwritten (${spec.label}) and deleted` });
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (msg === 'cancelled') {
        stopped = true;
        results.push({ path: f.path, ok: false, detail: 'Left partially overwritten — the erase was cancelled' });
      } else {
        results.push({ path: f.path, ok: false, detail: msg });
      }
    }
    if (onProgress) onProgress(i + 1, (files || []).length);
  }
  return { results, cancelled: stopped };
}
