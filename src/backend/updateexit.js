// The installer writes a marker beside Purgeon's executable before replacing
// the program files. The native updater validates and consumes that marker.
import { sys } from './sys.js';
import * as log from './log.js';

export async function checkExitMarker() {
  const shouldExit = await sys.consumeUpdateExitMarker?.().catch(() => false);
  if (shouldExit !== true) return false;
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
