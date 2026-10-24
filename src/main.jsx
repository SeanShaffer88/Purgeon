import { createRoot } from 'react-dom/client';
import { setSys } from './backend/sys.js';
import { createTauriSys } from './backend/tauri-sys.js';
import { api, initBackend, __handlers } from './backend/api.js';
import './styles.css';

async function start() {
  setSys(await createTauriSys());
  await initBackend();
  // The UI talks to the backend through window.api; keyboard shortcuts are handled in App.
  window.api = { invoke: api.invoke, onMeasured: api.onMeasured, onMenu: () => () => {} };
  window.__sweepHandlers = __handlers;
  const { default: App } = await import('./App.jsx');
  createRoot(document.getElementById('root')).render(<App />);
}

start().catch((e) => {
  document.getElementById('root').textContent = `SweepUninstall could not start: ${e?.message || e}`;
});
