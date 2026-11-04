import { initBackend as initialize } from '../../packages/purgeon-core/src/internal/api.js';
import { watchExitMarker } from './updateexit.js';
export { api, setConfirmUI, __handlers, runUninstaller } from '../../packages/purgeon-core/src/internal/api.js';
export async function initBackend() {
  await initialize();
  watchExitMarker();
}
