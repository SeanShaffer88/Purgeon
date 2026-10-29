import { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog } from './dialogs.jsx';

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

  const refresh = async () => {
    try {
      const r = await api.invoke('processes:sample');
      if (!alive.current) return;
      setData(r);
      setHistory(h => ({ cpu: [...h.cpu, r.totals.cpuPct].slice(-30), mem: [...h.mem, r.totals.memPct].slice(-30) }));
    } catch (e) {
      if (alive.current) onError(e.message);
    }
  };

  useEffect(() => {
    alive.current = true;
    refresh();
    api.invoke('processes:alertThresholds').then(setThresholds).catch(() => {});
    const t = setInterval(refresh, 2000);
    return () => { alive.current = false; clearInterval(t); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => onStatus(
    data ? `${data.processes.length} processes · processor ${data.totals.cpuPct}% · memory ${data.totals.memPct}%` : 'Processes'
  ), [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = useMemo(() => {
    const q = (filter || '').trim().toLowerCase();
    return (data?.processes || []).filter(p => !q || p.name.toLowerCase().includes(q));
  }, [data, filter]);
  const current = shown.find(p => p.pid === sel) || (data?.processes || []).find(p => p.pid === sel) || null;

  const act = async (fn) => { try { await fn(); refresh(); } catch (e) { onError(e.message); } };
  const t = data?.totals;

  return (
    <div className="proc-view">
      <div className="proc-meters">
        <div className="proc-meter">
          <h3>Processor</h3>
          <div className="proc-big">{t ? `${t.cpuPct}%` : '…'}</div>
          <div className="proc-bar"><i style={{ width: `${t?.cpuPct || 0}%` }} /></div>
          <Spark points={history.cpu} />
        </div>
        <div className="proc-meter">
          <h3>Memory{t ? ` · ${t.memUsedGB} of ${t.memTotalGB} GB` : ''}</h3>
          <div className="proc-big">{t ? `${t.memPct}%` : '…'}</div>
          <div className="proc-bar"><i style={{ width: `${t?.memPct || 0}%` }} /></div>
          <Spark points={history.mem} />
        </div>
        <div className="proc-meter">
          <h3>Disk{t ? ` ${t.systemDrive} · ${t.systemFreeGB} GB free` : ''}</h3>
          <div className="proc-big">{t ? `${t.diskPct}% free` : '…'}</div>
          <div className="proc-bar"><i className="amber" style={{ width: `${t?.diskPct || 0}%` }} /></div>
          <p className="proc-alerts">
            Alerts while Purgeon runs: processor over {thresholds.cpu}% · memory over {thresholds.mem}% · disk under {thresholds.diskFreeGB} GB free{' '}
            <button className="linklike" title="Change when Purgeon warns you about a busy PC" onClick={() => setAlertEdit(true)}>Change…</button>
          </p>
        </div>
      </div>

      <div className="proc-head"><span className="proc-c-name">Process</span><span className="proc-c-num">Processor</span><span className="proc-c-num">Memory</span><span className="proc-c-badge">Priority</span></div>
      <div className="proc-list">
        {shown.map(p => (
          <div key={p.pid} className={`proc-row${p.pid === sel ? ' sel' : ''}`} onClick={() => setSel(p.pid)} title={p.path || p.name}>
            <span className="proc-c-name">{p.name} <span className="muted">· {p.pid}</span>{p.suspended && <span className="badge warn" style={{ marginLeft: 8 }}>Suspended</span>}</span>
            <span className="proc-c-num">{p.cpuPct.toFixed(1)}%</span>
            <span className="proc-c-num">{p.memMB.toLocaleString()} MB</span>
            <span className="proc-c-badge"><span className={`badge${p.priority === 'High' || p.priority === 'AboveNormal' ? ' warn' : ' grey'}`}>{p.priority}</span></span>
          </div>
        ))}
        {data && shown.length === 0 && <p className="muted">No processes match the search.</p>}
        {!data && <p className="muted">Reading the process list…</p>}
      </div>

      <div className="proc-actions">
        <button disabled={!current || !!current.guarded} title={current?.guarded || 'Close the selected process straight away'} onClick={() => setConfirmEnd(current)}>End Process</button>
        {current?.suspended
          ? <button disabled={!current} title="Let a suspended process run again" onClick={() => act(() => api.invoke('processes:resume', current.pid))}>Resume</button>
          : <button disabled={!current || !!current.guarded} title={current?.guarded || 'Freeze the selected process where it stands, without closing it'} onClick={() => current && act(() => api.invoke('processes:suspend', { pid: current.pid, name: current.name }))}>Suspend</button>}
        <span className="proc-prio">
          <button disabled={!current || !!current.guarded} title={current?.guarded || 'How much of the processor this process gets when the PC is busy'} onClick={() => setPrioOpen(o => !o)}>Priority ▾</button>
          {prioOpen && current && (
            <span className="context-menu proc-prio-menu">
              {SETTABLE.map(level => (
                <button key={level} className="menu-item" title={`Set ${current.name} to ${level} priority`} onClick={() => { setPrioOpen(false); act(() => api.invoke('processes:setPriority', { pid: current.pid, name: current.name, level, previous: current.priority })); }}>
                  {level}{level === current.priority ? ' ✓' : ''}
                </button>
              ))}
            </span>
          )}
        </span>
        <button disabled={!current || !!current.guarded} title={current?.guarded || 'Choose which processor cores this process may run on'} onClick={() => current && setAffinityFor(current)}>Processor Affinity…</button>
        <button disabled={!current?.path} title="Open the folder this process runs from" onClick={() => current?.path && api.invoke('processes:openFolder', current.path).catch(e => onError(e.message))}>Open Folder</button>
      </div>
      <p className="muted">Windows' own critical processes can't be ended or suspended — Purgeon says so instead of trying. Updates every 2 seconds while this view is open.</p>

      {confirmEnd && (
        <Dialog title="End this process?" onClose={() => setConfirmEnd(null)} buttons={<>
          <button onClick={() => setConfirmEnd(null)}>Keep It Running</button>
          <button className="danger" title="End the process now — anything it hasn't saved is lost" onClick={() => { const p = confirmEnd; setConfirmEnd(null); act(() => api.invoke('processes:end', { pid: p.pid, name: p.name })); }}>End Process</button>
        </>}>
          <p><strong>{confirmEnd.name}</strong> will close straight away. Anything it hasn't saved is lost. Purgeon can't undo ending a process.</p>
        </Dialog>
      )}

      {affinityFor && t && (
        <AffinityDialog proc={affinityFor} cores={t.cores} onClose={() => setAffinityFor(null)}
          onApply={(cores) => { const p = affinityFor; setAffinityFor(null); act(() => api.invoke('processes:setAffinity', { pid: p.pid, name: p.name, cores })); }} />
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
    <Dialog title={`Processor affinity — ${proc.name}`} onClose={onClose} buttons={<>
      <button onClick={onClose}>Cancel</button>
      <button className="primary" disabled={on.size === 0} title="Let this process use only the ticked cores" onClick={() => onApply([...on].sort((a, b) => a - b))}>Apply</button>
    </>}>
      <p className="muted" style={{ marginBottom: 10 }}>Tick the processor cores {proc.name} may run on. At least one must stay ticked.</p>
      <div className="proc-cores">
        {Array.from({ length: cores }, (_, i) => (
          <label key={i} className="proc-core" title={`Core ${i}`}>
            <input type="checkbox" checked={on.has(i)} onChange={() => toggle(i)} /> Core {i}
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
    <Dialog title="Resource alerts" onClose={onClose} buttons={<>
      <button onClick={onClose}>Cancel</button>
      <button className="primary" title="Save these alert levels" onClick={() => onSave(v)}>Save</button>
    </>}>
      <p className="muted" style={{ marginBottom: 10 }}>Purgeon warns you — once, until things calm down — when the PC stays this busy. Alerts only run while Purgeon is open or in the tray. Set a level to 0 to turn that alert off.</p>
      <label className="proc-field">Processor over <input type="number" min="0" max="100" value={v.cpu} onChange={num('cpu')} /> %</label>
      <label className="proc-field">Memory over <input type="number" min="0" max="100" value={v.mem} onChange={num('mem')} /> %</label>
      <label className="proc-field">System disk under <input type="number" min="0" max="100" value={v.diskFreeGB} onChange={num('diskFreeGB')} /> GB free</label>
    </Dialog>
  );
}
