// Start with Windows uses the native caller-owned sign-in task catalog.
// Legacy/name collisions are reported for manual review, never silently removed.
import * as tasks from './tasks.js';
export async function enabled() { const state = await tasks.ownedStatus('signin'); return state.registered && state.enabled; }
export async function set(on) { const state = await tasks.configureOwned('signin', on); return state.registered && state.enabled; }
