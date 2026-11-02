import { tx } from './backend/i18n.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog } from './core-dialog.jsx';
import { createRefreshGate } from './refresh-gate.js';

const api = window.api;
const SETTABLE = ['Idle', 'BelowNormal', 'Normal', 'AboveNormal', 'High'];

function Spark({ points, max = 100 }) {
  if (points.length < 2) return <div className="proc-spark" />;
  const step = 100 / (points.length - 1);
  const pts = points.map((v, i) => `${(i * step).toFixed(1)},${(22 - Math.min(max, v) / max * 20).toFixed(1)}`).join(' ');
  return (
    <svg className="proc-spark" viewBox="0 0 100 22" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={pts} fill="none" stroke="var(--accent, #cf2e33)" strokeWidth="1.2" />
    </svg>
  );
}

// Processes: what is running right now, how much of the PC it is using, and
// the controls to end, pause, slow down or speed up a process. Refreshes
// every 2 seconds while open. Windows' critical processes and Purgeon
// itself are guarded in the backend and shown without action buttons.
export function ProcessesView({ filter, onError, onStatus }) {
  const [data, setData] = useState(null);
  const [history, setHistory] = useState({ cpu: [], mem: [] });
  const [sel, setSel] = useState(null); // pid
  const [confirmEnd, setConfirmEnd] = useState(null);
  const [prioOpen, setPrioOpen] = useState(false);
  const [affinityFor, setAffinityFor] = useState(null); // proc
  const [alertEdit, setAlertEdit] = useState(false);
  const [thresholds, setThresholds] = useState({ cpu: 90, mem: 90, diskFreeGB: 20 });
  const alive = useRef(true);
  const refreshGate = useRef(null);
  const refresh = (force = false) => refreshGate.current?.request(force);

  useEffect(() => {
    alive.current = true;
    const gate = createRefreshGate(() => api.invoke('processes:sample'), (r) => {
      setData(r);
      setHistory(h => ({ cpu: [...h.cpu, r.totals.cpuPct].slice(-30), mem: [...h.mem, r.totals.memPct].slice(-30) }));
    }, (e) => onError(e.message));
    refreshGate.current = gate;
    gate.request();
    let active = true;
    api.invoke('processes:alertThresholds').then((value) => { if (active) setThresholds(value); }).catch(() => {});
    const t = setInterval(refresh, 2000);
    return () => { active = false; alive.current = false; gate.dispose(); if (refreshGate.current === gate) refreshGate.current = null; clearInterval(t); };
  }, []);

  useEffect(() => onStatus(
    data ? `${data.processes.length} processes · processor ${data.totals.cpuPct}% · memory ${data.totals.memPct}%` : 'Processes'
  ), [data]);

  const shown = useMemo(() => {
    const q = (filter || '').trim().toLowerCase();
    return (data?.processes || []).filter(p => !q || p.name.toLowerCase().includes(q));
  }, [data, filter]);
  const current = shown.find(p => p.pid === sel) || (data?.processes || []).find(p => p.pid === sel) || null;

  const act = async (fn) => { try { await fn(); if (alive.current) refresh(true); } catch (e) { if (alive.current) onError(e.message); } };
  const t = data?.totals;

  return (
    <div className="proc-view">
      <div className="proc-meters">
        <div className="proc-meter">
          <h3>{tx("Processor")}</h3>
          <div className="proc-big">{t ? `${t.cpuPct}%` : '…'}</div>
          <div className="proc-bar"><i style={{ width: `${t?.cpuPct || 0}%` }} /></div>
          <Spark points={history.cpu} />
        </div>
        <div className="proc-meter">
          <h3>{tx("Memory")}{t ? tx(" · {p0} of {p1} GB", { p0: (t.memUsedGB), p1: (t.memTotalGB) }) : ''}</h3>
          <div className="proc-big">{t ? `${t.memPct}%` : '…'}</div>
          <div className="proc-bar"><i style={{ width: `${t?.memPct || 0}%` }} /></div>
          <Spark points={history.mem} />
        </div>
        <div className="proc-meter">
          <h3>{tx("Disk")}{t ? tx(" {p0} · {p1} GB free", { p0: (t.systemDrive), p1: (t.systemFreeGB) }) : ''}</h3>
          <div className="proc-big">{t ? tx("{p0}% free", { p0: (t.diskPct) }) : '…'}</div>
          <div className="proc-bar"><i className="amber" style={{ width: `${t?.diskPct || 0}%` }} /></div>
          <p className="proc-alerts">{tx("Alerts while Purgeon runs: processor over ")}{thresholds.cpu}{tx("% · memory over ")}{thresholds.mem}{tx("% · disk under ")}{thresholds.diskFreeGB}{tx(" GB free")}{' '}
            <button className="linklike" title={tx("Change when Purgeon warns you about a busy PC")} onClick={() => setAlertEdit(true)}>{tx("Change…")}</button>
          </p>
        </div>
      </div>

      <div className="proc-head"><span className="proc-c-name">{tx("Process")}</span><span className="proc-c-num">{tx("Processor")}</span><span className="proc-c-num">{tx("Memory")}</span><span className="proc-c-badge">{tx("Priority")}</span></div>
      <div className="proc-list">
        {shown.map(p => (
          <div key={p.pid} className={`proc-row${p.pid === sel ? ' sel' : ''}`} onClick={() => setSel(p.pid)} title={p.path || p.name}>
            <span className="proc-c-name">{p.name} <span className="muted">· {p.pid}</span>{p.suspended && <span className="badge warn" style={{ marginLeft: 8 }}>{tx("Suspended")}</span>}</span>
            <span className="proc-c-num">{p.cpuPct.toFixed(1)}%</span>
            <span className="proc-c-num">{p.memMB.toLocaleString()}{tx(" MB")}</span>
            <span className="proc-c-badge"><span className={`badge${p.priority === 'High' || p.priority === 'AboveNormal' ? ' warn' : ' grey'}`}>{p.priority}</span></span>
          </div>
        ))}
        {data && shown.length === 0 && <p className="muted">{tx("No processes match the search.")}</p>}
        {!data && <p className="muted">{tx("Reading the process list…")}</p>}
      </div>

      <div className="proc-actions">
        <button disabled={!current || !!current.guarded} title={current?.guarded || tx("Close the selected process straight away")} onClick={() => setConfirmEnd(current)}>{tx("End Process")}</button>
        {current?.suspended
          ? <button disabled={!current} title={tx("Let a suspended process run again")} onClick={() => act(() => api.invoke('processes:resume', current))}>{tx("Resume")}</button>
          : <button disabled={!current || !!current.guarded} title={current?.guarded || tx("Freeze the selected process where it stands, without closing it")} onClick={() => current && act(() => api.invoke('processes:suspend', { pid: current.pid, name: current.name, creationTime: current.creationTime }))}>{tx("Suspend")}</button>}
        <span className="proc-prio">
          <button disabled={!current || !!current.guarded} title={current?.guarded || tx("How much of the processor this process gets when the PC is busy")} onClick={() => setPrioOpen(o => !o)}>{tx("Priority ▾")}</button>
          {prioOpen && current && (
            <span className="context-menu proc-prio-menu">
              {SETTABLE.map(level => (
                <button key={level} className="menu-item" title={tx("Set {p0} to {p1} priority", { p0: (current.name), p1: (level) })} onClick={() => { setPrioOpen(false); act(() => api.invoke('processes:setPriority', { pid: current.pid, name: current.name, creationTime: current.creationTime, level, previous: current.priority })); }}>
                  {level}{level === current.priority ? ' ✓' : ''}
                </button>
              ))}
            </span>
          )}
        </span>
        <button disabled={!current || !!current.guarded} title={current?.guarded || tx("Choose which processor cores this process may run on")} onClick={() => current && setAffinityFor(current)}>{tx("Processor Affinity…")}</button>
        <button disabled={!current?.path} title={tx("Open the folder this process runs from")} onClick={() => current?.path && api.invoke('processes:openFolder', current.path).catch(e => onError(e.message))}>{tx("Open Folder")}</button>
      </div>
      <p className="muted">{tx("Windows' own critical processes can't be ended or suspended — Purgeon says so instead of trying. Updates every 2 seconds while this view is open.")}</p>

      {confirmEnd && (
        <Dialog title={tx("End this process?")} onClose={() => setConfirmEnd(null)} buttons={<>
          <button onClick={() => setConfirmEnd(null)}>{tx("Keep It Running")}</button>
          <button className="danger" title={tx("End the process now — anything it hasn't saved is lost")} onClick={() => { const p = confirmEnd; setConfirmEnd(null); act(() => api.invoke('processes:end', { pid: p.pid, name: p.name, creationTime: p.creationTime })); }}>{tx("End Process")}</button>
        </>}>
          <p><strong>{confirmEnd.name}</strong>{tx(" will close straight away. Anything it hasn't saved is lost. Purgeon can't undo ending a process.")}</p>
        </Dialog>
      )}

      {affinityFor && t && (
        <AffinityDialog proc={affinityFor} cores={t.cores} onClose={() => setAffinityFor(null)}
          onApply={(cores) => { const p = affinityFor; setAffinityFor(null); act(() => api.invoke('processes:setAffinity', { pid: p.pid, name: p.name, creationTime: p.creationTime, cores })); }} />
      )}

      {alertEdit && (
        <AlertDialog value={thresholds} onClose={() => setAlertEdit(false)}
          onSave={(v) => { setAlertEdit(false); setThresholds(v); api.invoke('processes:setAlertThresholds', v).catch(e => onError(e.message)); }} />
      )}
    </div>
  );
}

function AffinityDialog({ proc, cores, onClose, onApply }) {
  const [on, setOn] = useState(() => new Set(Array.from({ length: cores }, (_, i) => i)));
  const toggle = (i) => setOn(s => { const n = new Set(s); n.has(i) ? n.delete(i) : n.add(i); return n; });
  return (
    <Dialog title={tx("Processor affinity — {p0}", { p0: (proc.name) })} onClose={onClose} buttons={<>
      <button onClick={onClose}>{tx("Cancel")}</button>
      <button className="primary" disabled={on.size === 0} title={tx("Let this process use only the ticked cores")} onClick={() => onApply([...on].sort((a, b) => a - b))}>{tx("Apply")}</button>
    </>}>
      <p className="muted" style={{ marginBottom: 10 }}>{tx("Tick the processor cores ")}{proc.name}{tx(" may run on. At least one must stay ticked.")}</p>
      <div className="proc-cores">
        {Array.from({ length: cores }, (_, i) => (
          <label key={i} className="proc-core" title={tx("Core {p0}", { p0: (i) })}>
            <input type="checkbox" checked={on.has(i)} onChange={() => toggle(i)} />{tx(" Core ")}{i}
          </label>
        ))}
      </div>
    </Dialog>
  );
}

function AlertDialog({ value, onClose, onSave }) {
  const [v, setV] = useState(value);
  const num = (k) => (e) => setV(x => ({ ...x, [k]: Math.max(0, Math.min(100, Number(e.target.value) || 0)) }));
  return (
    <Dialog title={tx("Resource alerts")} onClose={onClose} buttons={<>
      <button onClick={onClose}>{tx("Cancel")}</button>
      <button className="primary" title={tx("Save these alert levels")} onClick={() => onSave(v)}>{tx("Save")}</button>
    </>}>
      <p className="muted" style={{ marginBottom: 10 }}>{tx("Purgeon warns you — once, until things calm down — when the PC stays this busy. Alerts only run while Purgeon is open or in the tray. Set a level to 0 to turn that alert off.")}</p>
      <label className="proc-field">{tx("Processor over ")}<input type="number" min="0" max="100" value={v.cpu} onChange={num('cpu')} /> %</label>
      <label className="proc-field">{tx("Memory over ")}<input type="number" min="0" max="100" value={v.mem} onChange={num('mem')} /> %</label>
      <label className="proc-field">{tx("System disk under ")}<input type="number" min="0" max="100" value={v.diskFreeGB} onChange={num('diskFreeGB')} />{tx(" GB free")}</label>
    </Dialog>
  );
}
