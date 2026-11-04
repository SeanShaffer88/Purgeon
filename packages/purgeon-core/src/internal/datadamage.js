// When one of Purgeon's own data files cannot be read — damaged JSON, usually
// from a crash or power cut at the wrong moment — the damaged text is kept:
// copied beside the original with ".damaged" in the name, so nothing is lost
// silently. Each incident is recorded here so the app can tell the user what
// happened instead of quietly starting over with defaults.
import { sys } from './sys.js';
import * as path from './winpath.js';

const recorded = [];
export const list = () => recorded.map((d) => ({ ...d }));

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

// Keeps a copy of the damaged text next to the original file and records the
// incident. Returns the copy's full path.
export async function quarantine(file, text) {
  const base = path.basename(file);
  const copy = path.join(path.dirname(file), `${base}.damaged-${stamp()}`);
  await sys.writeText(copy, text);
  recorded.push({ file: base, copy: path.basename(copy) });
  return copy;
}
