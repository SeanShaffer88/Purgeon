import { useEffect, useMemo, useRef, useState } from 'react';
import { formatBytes } from './junk.jsx';
import { crumbsOf, parentOf, shareText } from './backend/diskusage.js';

const api = window.api;

// Disk Usage: what's eating the disk, biggest first. Pick a drive, then open
// folders to drill down. Read-only — nothing here changes anything.
export function DiskUsageView({ filter, onError, onStatus }) {
  const [drives, setDrives] = useState(null);
  const [path, setPath] = useState(null);
  const [data, setData] = useState(null); // { entries, total, complete }
  const [scanning, setScanning] = useState(false);
  const run = useRef(0);

  const scan = async (dir) => {
    const id = ++run.current;
    setPath(dir);
    setData(null);
    setScanning(true);
    try {
      const r = await api.invoke('disk:scan', dir);
      if (run.current !== id) return; // a newer scan took over
      setData(r);
    } catch (e) {
      if (run.current === id) onError(e.message);
    } finally {
      if (run.current === id) setScanning(false);
    }
  };

  useEffect(() => {
    api
      .invoke('disk:drives')
      .then((d) => {
        setDrives(d);
        if (d.length) scan(d[0].root);
        else setData({ entries: [], total: 0, complete: true });
      })
      .catch((e) => {
        onError(e.message);
        setDrives([]);
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (scanning) return onStatus(`Measuring ${path || ''}…`);
    if (data) return onStatus(`${formatBytes(data.total)} in ${data.entries.length} items${data.complete ? '' : ' (scan stopped early)'}`);
    return onStatus('Disk Usage');
  }, [data, scanning, path]); // eslint-disable-line react-hooks/exhaustive-deps

  const cancel = () => api.invoke('disk:scanCancel').catch(() => {});
  const up = parentOf(path || '');
  const crumbs = useMemo(() => crumbsOf(path || ''), [path]);
  const shown = useMemo(() => {
    const q = (filter || '').trim().toLowerCase();
    return (data?.entries || []).filter((e) => !q || e.name.toLowerCase().includes(q));
  }, [data, filter]);
  const max = shown.reduce((n, e) => Math.max(n, e.bytes), 0);

  return (
    <div className="disk">
      <div className="disk-drives" role="group" aria-label="Drives">
        {(drives || []).map((d) => (
          <button key={d.root} className={`drive-chip ${path && path.toUpperCase().startsWith(d.root.toUpperCase()) ? 'on' : ''}`} onClick={() => scan(d.root)} title={`Show drive ${d.root} — ${formatBytes(d.free)} free of ${formatBytes(d.used + d.free)}`}>
            <span className="drive-letter">{d.root}</span>
            <span className="drive-meta">{formatBytes(d.free)} free</span>
            <span className="drive-track"><span className="drive-fill" style={{ width: `${d.used + d.free > 0 ? Math.round((d.used / (d.used + d.free)) * 100) : 0}%` }} /></span>
          </button>
        ))}
        {drives && !drives.length && <span className="muted">No drives found.</span>}
      </div>

      <div className="disk-nav">
        <button className="debloat-button" disabled={!up || scanning} onClick={() => up && scan(up)} title="Go up one folder">
          ↑ Up
        </button>
        <nav className="disk-crumbs" aria-label="Current folder">
          {crumbs.map((c, i) => (
            <span key={c.path}>
              {i > 0 && <span className="crumb-sep">›</span>}
              <button className="crumb" onClick={() => scan(c.path)} title={`Open ${c.path}`}>{c.label}</button>
            </span>
          ))}
        </nav>
        {scanning ? (
          <button className="debloat-button" onClick={cancel} title="Stop measuring; what is already measured stays on screen">
            Cancel
          </button>
        ) : (
          <button className="debloat-button" disabled={!path} onClick={() => path && scan(path)} title="Measure this folder again">
            Rescan
          </button>
        )}
      </div>

      {scanning && !data && <div className="list-empty">Measuring… the biggest folders can take a while.</div>}
      {data && !shown.length && <div className="list-empty">{data.entries.length ? 'Nothing here matches the search.' : 'This folder is empty, or Purgeon cannot read it.'}</div>}
      {data && !data.complete && <div className="disk-note">Scan stopped — sizes below are what was measured before it stopped.</div>}

      <div className="disk-list">
        {shown.map((e) => (
          <div key={e.path} className={`disk-row ${e.dir && !e.link ? 'openable' : ''}`}>
            <button
              className="disk-main"
              disabled={!e.dir || e.link}
              onClick={() => e.dir && !e.link && scan(e.path)}
              title={e.link ? `${e.path} — a link to another folder; not counted, so nothing is double-counted` : e.dir ? `Open ${e.path}` : e.path}
            >
              <span className="disk-name">
                {e.name}
                {e.link && <span className="disk-tag">link · not counted</span>}
                {e.partial && <span className="disk-tag">counting stopped early</span>}
              </span>
              <span className="disk-bar">
                <span className="disk-fill" style={{ width: `${e.bytes > 0 && max > 0 ? Math.max(1.5, (e.bytes / max) * 100) : 0}%` }} />
              </span>
            </button>
            <span className="disk-size">
              {e.partial ? 'at least ' : ''}
              {formatBytes(e.bytes)}
              <span className="disk-share">{shareText(e.bytes, data.total)}</span>
            </span>
            <button className="link" onClick={() => api.invoke('disk:open', e).catch(() => {})} title={`Open ${e.dir ? 'this folder' : "this file's folder"} in Explorer`}>
              Open
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
