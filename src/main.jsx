import { createRoot } from 'react-dom/client';
import { setSys, sys } from './backend/sys.js';
import { createTauriSys } from './backend/tauri-sys.js';
import { api, initBackend, __handlers } from './backend/api.js';
import './styles.css';

async function start() {
  setSys(await createTauriSys());
  // Command-line requests (see cli.js) run without showing the window.
  if (sys.info.args?.length) return (await import('./cli.js')).runCli(sys.info.args, initBackend);
  await initBackend();
  // The UI talks to the backend through window.api; keyboard shortcuts are handled in App.
  window.api = { invoke: api.invoke, onMeasured: api.onMeasured, onMenu: () => () => {} };
  window.__sweepHandlers = __handlers;
  window.__sweepPortable = !!sys.info.portable;
  window.__sweepLaunch = sys.info.launch || [];
  const { default: App } = await import('./App.jsx');
  createRoot(document.getElementById('root')).render(<App />);
  // A window hidden while minimized can come back at Windows' minimized size (far below the
  // window's smallest size); then it is put back at its remembered size (refit in lib.rs).
  const refit = () => {
    if (window.innerWidth < 300 && window.innerHeight < 100) import('@tauri-apps/api/core').then(({ invoke }) => invoke('refit_window')).catch(() => {});
  };
  window.addEventListener('focus', refit);
  document.addEventListener('visibilitychange', refit);
  setInterval(refit, 1000);
}

start().catch((e) => {
  document.getElementById('root').textContent = `Purgeon could not start: ${e?.message || e}`;
});
