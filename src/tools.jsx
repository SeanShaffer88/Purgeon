import { tx } from './backend/i18n.js';
import { useEffect, useState } from 'react';
import { Dialog } from './core-dialog.jsx';

const api = window.api;

// Tools › Who Owns This: which installed program a file, folder or registry key belongs to.
export function WhoOwnsDialog({ initial = '', onClose }) {
  const [target, setTarget] = useState(initial);
  const [results, setResults] = useState(null);
  const [busy, setBusy] = useState(false);
  const check = async (t = target) => {
    if (!t.trim()) return;
    setBusy(true);
    try {
      setResults(await api.invoke('owners:who', t.trim()));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (initial) check(initial);
  }, []);
  const browse = async (folder) => {
    const p = await api.invoke('owners:pick', folder);
    if (p) {
      setTarget(p);
      check(p);
    }
  };
  return (
    <Dialog
      title={tx("Who Owns This?")}
      onClose={onClose}
      width={680}
      buttons={
        <>
          <button className="primary" disabled={!target.trim() || busy} onClick={() => check()}>
            {busy ? tx("Checking…") : tx("Check")}
          </button>
          <button onClick={onClose}>{tx("Close")}</button>
        </>
      }
    >
      <p className="heading">{tx("Find out which installed program a file, folder or registry key belongs to.")}</p>
      <div className="field-row">
        <input autoFocus title={tx("A file or folder path, or a registry key such as HKEY_CURRENT_USER\\Software\\Something")} value={target} placeholder={tx("C:\\ProgramData\\Something  or  HKEY_CURRENT_USER\\Software\\Something")} onChange={(e) => setTarget(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && check()} />
        <button onClick={() => browse(true)}>{tx("Folder…")}</button>
        <button onClick={() => browse(false)}>{tx("File…")}</button>
      </div>
      {results && (
        <div className="tree owners">
          {results.length === 0 && <div className="empty-box">{tx("No installed program matches it. It may be a leftover; Tools › Find Orphaned Leftovers looks for these.")}</div>}
          {results.map((r) => (
            <div key={r.name} className="tree-item">
              <span className={`score ${r.score >= 90 ? 'hi' : r.score >= 60 ? 'mid' : 'lo'}`}>{r.score ? `${r.score}%` : '—'}</span>
              <b>{r.name}</b>
              <span className="muted">{r.why}</span>
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}

// Tools › Program Updates: newer versions available through winget, updated silently.
export function UpdatesDialog({ onUpdate, onClose }) {
  const [state, setState] = useState({ loading: true, version: '', list: [], error: '' });
  const [chosen, setChosen] = useState(new Set());
  useEffect(() => {
    (async () => {
      const version = await api.invoke('winget:available').catch(() => '');
      if (!version) return setState({ loading: false, version: '', list: [], error: 'winget (Windows Package Manager) is not installed. It comes with the App Installer app from the Microsoft Store.' });
      try {
        const list = await api.invoke('winget:upgrades');
        setState({ loading: false, version, list, error: '' });
        setChosen(new Set(list.map((u) => u.id)));
      } catch (e) {
        setState({ loading: false, version, list: [], error: e.message });
      }
    })();
  }, []);
  const toggle = (id) =>
    setChosen((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  return (
    <Dialog
      title={tx("Program Updates")}
      onClose={onClose}
      width={720}
      buttons={
        <>
          <span className="button-hint">{chosen.size}{tx(" selected")}</span>
          <button className="primary" disabled={!chosen.size} onClick={() => onUpdate(state.list.filter((u) => chosen.has(u.id)))}>{tx("Update Selected")}</button>
          <button onClick={onClose}>{tx("Close")}</button>
        </>
      }
    >
      <p className="heading">{tx("Newer versions available through winget, the Windows Package Manager")}{state.version ? ` (${state.version})` : ''}.</p>
      {state.loading && <div className="empty-box">{tx("Checking for updates…")}</div>}
      {state.error && <div className="error-box">{state.error}</div>}
      {!state.loading && !state.error && !state.list.length && <div className="empty-box">{tx("Everything winget knows about is up to date.")}</div>}
      {state.list.length > 0 && (
        <div className="tree">
          {state.list.map((u) => (
            <label key={u.id} className="tree-item">
              <input type="checkbox" checked={chosen.has(u.id)} onChange={() => toggle(u.id)} />
              <span className="path">
                <b>{u.name}</b> <span className="muted">{u.id}</span>
              </span>
              <span className="compare-extra">
                {u.version === 'Unknown' ? tx("version unknown") : u.version} → {u.available}
              </span>
            </label>
          ))}
        </div>
      )}
      <p className="footnote">{tx("Updates run silently one after another. Updating accepts each package's license terms. A restore point is offered first if Create Restore Points is on.")}</p>
    </Dialog>
  );
}

// Tools › Scheduled Maintenance: a weekly snapshot, junk clean-up and backup limits.
export function MaintenanceDialog({ settings, categories, status, onSave, onRunNow, onClose }) {
  const [m, setM] = useState(settings);
  const set = (patch) => setM((x) => ({ ...x, ...patch }));
  const toggleJunk = (id) => set({ junk: m.junk.includes(id) ? m.junk.filter((x) => x !== id) : [...m.junk, id] });
  return (
    <Dialog
      title={tx("Scheduled Maintenance")}
      onClose={onClose}
      width={600}
      buttons={
        <>
          <button onClick={onRunNow}>{tx("Run Now")}</button>
          <button className="primary" onClick={() => onSave(m)}>{tx("Save")}</button>
          <button onClick={onClose}>{tx("Cancel")}</button>
        </>
      }
    >
      <p className="heading">{tx("Once a week, Windows runs Purgeon in the background to keep things tidy. Programs are never uninstalled. Cleanup recovery depends on retained records and Recycle Bin copies.")}</p>
      <label className="check-row">
        <input type="checkbox" checked={m.enabled} onChange={(e) => set({ enabled: e.target.checked })} />{tx(" Run weekly maintenance")}</label>
      <div className="field-row maintenance-when">
        <select title={tx("The day of the week maintenance runs")} value={m.day} disabled={!m.enabled} onChange={(e) => set({ day: e.target.value })}>
          {['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((d) => (
            <option key={d}>{d}</option>
          ))}
        </select>
        <input title={tx("The time of day maintenance runs, like 10:00. If the PC is off then, it runs when it is next on.")} value={m.time} disabled={!m.enabled} onChange={(e) => set({ time: e.target.value.trim() })} placeholder="10:00" />
      </div>
      <label className="check-row">
        <input type="checkbox" checked={m.snapshot} disabled={!m.enabled} onChange={(e) => set({ snapshot: e.target.checked })} />{tx(" Take a Quick snapshot")}</label>
      <div className="field">{tx("Clean these junk files (to the Recycle Bin)")}</div>
      <div className="maintenance-junk">
        {categories.map((c) => (
          <label key={c.id} className="check-row">
            <input type="checkbox" checked={m.junk.includes(c.id)} disabled={!m.enabled} onChange={() => toggleJunk(c.id)} /> {tx(c.label)}
          </label>
        ))}
      </div>
      <p className="footnote">
        {status?.registered ? tx("Scheduled. Next run: {p0}{p1}.", { p0: (status.nextRun ? new Date(status.nextRun).toLocaleString() : 'not set'), p1: (status.lastRun ? ` · last run ${new Date(status.lastRun).toLocaleString()}` : '') }) : tx("Not scheduled.")}{tx(" Backup limits from Tools › Backup Settings are applied too. Windows' own permanent clean-ups are never run automatically.")}</p>
    </Dialog>
  );
}
