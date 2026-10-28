// The installer closes a running Purgeon before it replaces the program's
// files: it drops a small marker file next to the program, and this watch
// exits the app through the normal quit path when a fresh marker appears.
// A marker older than two minutes is ignored (and removed), so a leftover
// from an interrupted install can never close a later launch.
import { sys } from './sys.js';
import * as path from './winpath.js';
import * as log from './log.js';

export const MARKER_NAME = 'exit-for-update';
export const FRESH_MS = 120000;

export function markerPath(exe) {
  return exe ? path.join(path.dirname(exe), MARKER_NAME) : '';
}

// Pure decision: exit only for a real file whose modified time is fresh.
// A small negative age is allowed for clock skew between writer and reader.
export function shouldExitForMarker(stat, now) {
  if (!stat || stat.dir) return false;
  const age = now - (stat.modified || 0);
  return age >= -5000 && age <= FRESH_MS;
}

export async function checkExitMarker(now = Date.now()) {
  const file = markerPath(sys.info?.exe);
  if (!file) return false;
  const stat = await sys.stat(file).catch(() => null);
  if (!stat) return false;
  // Present but stale: clean it up so it cannot fire later.
  await sys.removePath(file).catch(() => {});
  if (!shouldExitForMarker(stat, now)) return false;
  await log.flushNow().catch(() => {});
  await sys.quit().catch(() => {});
  return true;
}

let timer = null;
export function watchExitMarker() {
  if (timer) return;
  timer = setInterval(() => { checkExitMarker().catch(() => {}); }, 2000);
  checkExitMarker().catch(() => {});
}
