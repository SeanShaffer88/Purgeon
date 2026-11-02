import { tx } from './backend/i18n.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatBytes } from './format.js';
import { crumbsOf, parentOf, shareText, systemDriveRoot } from './backend/diskusage.js';

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
        // Opening the view scans a drive straight away: the system drive
        // when it is listed, otherwise the first one.
        const start = d.find((x) => x.root.toLowerCase() === systemDriveRoot().toLowerCase()) || d[0];
        if (start) scan(start.root);
        else setData({ entries: [], total: 0, complete: true });
      })
      .catch((e) => {
        onError(e.message);
        setDrives([]);
      });
  }, []);

  useEffect(() => {
    if (scanning) return onStatus(`Measuring ${path || ''}…`);
    if (data) return onStatus(`${formatBytes(data.total)} in ${data.entries.length} items${data.complete ? '' : ' (scan stopped early)'}`);
    return onStatus('Disk Usage');
  }, [data, scanning, path]);

  const cancel = () => api.invoke('disk:scanCancel').catch(() => {});
  const up = parentOf(path || '');
  const crumbs = useMemo(() => crumbsOf(path || ''), [path]);
  const shown = useMemo(() => {
    const q = (filter || '').trim().toLowerCase();
    return (data?.entries || []).filter((e) => !q || e.name.toLowerCase().includes(q));
  }, [data, filter]);
  const max = shown.reduce((n, e) => Math.max(n, e.bytes), 0);

  return (
    <div className="disk-view">
      <div className="disk-drives" role="group" aria-label={tx("Drives")}>
        {(drives || []).map((d) => (
          <button key={d.root} className={`drive-chip ${path && path.toUpperCase().startsWith(d.root.toUpperCase()) ? 'on' : ''}`} onClick={() => scan(d.root)} title={tx("Show drive {p0} — {p1} free of {p2}", { p0: (d.root), p1: (formatBytes(d.free)), p2: (formatBytes(d.used + d.free)) })}>
            <span className="drive-letter">{d.root}</span>
            <span className="drive-meta">{formatBytes(d.free)}{tx(" free")}</span>
            <span className="drive-track"><span className="drive-fill" style={{ width: `${d.used + d.free > 0 ? Math.round((d.used / (d.used + d.free)) * 100) : 0}%` }} /></span>
          </button>
        ))}
        {drives && !drives.length && <span className="muted">{tx("No drives found.")}</span>}
      </div>

      <div className="disk-nav">
        <button className="debloat-button" disabled={!up || scanning} onClick={() => up && scan(up)} title={tx("Go up one folder")}>{tx("↑ Up")}</button>
        <nav className="disk-crumbs" aria-label={tx("Current folder")}>
          {crumbs.map((c, i) => (
            <span key={c.path}>
              {i > 0 && <span className="crumb-sep">›</span>}
              <button className="crumb" onClick={() => scan(c.path)} title={tx("Open {p0}", { p0: (c.path) })}>{tx(c.label)}</button>
            </span>
          ))}
        </nav>
        {scanning ? (
          <button className="debloat-button" onClick={cancel} title={tx("Stop measuring; what is already measured stays on screen")}>{tx("Cancel")}</button>
        ) : (
          <button className="debloat-button" disabled={!path} onClick={() => path && scan(path)} title={tx("Measure this folder again")}>{tx("Rescan")}</button>
        )}
      </div>

      {scanning && !data && <div className="list-empty">{tx("Measuring… the biggest folders can take a while.")}</div>}
      {data && !shown.length && <div className="list-empty">{data.entries.length ? tx("Nothing here matches the search.") : tx("This folder is empty, or Purgeon cannot read it.")}</div>}
      {data && !data.complete && <div className="disk-note">{tx("Scan stopped — sizes below are what was measured before it stopped.")}</div>}

      <div className="disk-list">
        {shown.map((e) => (
          <div key={e.path} className={`disk-row ${e.dir && !e.link ? 'openable' : ''}`}>
            <button
              className="disk-main"
              disabled={!e.dir || e.link}
              onClick={() => e.dir && !e.link && scan(e.path)}
              title={e.link ? tx("{p0} — a link to another folder; not counted, so nothing is double-counted", { p0: (e.path) }) : e.dir ? tx("Open {p0}", { p0: (e.path) }) : e.path}
            >
              <span className="disk-name">
                {e.name}
                {e.link && <span className="disk-tag">{tx("link · not counted")}</span>}
                {e.partial && <span className="disk-tag">{tx("counting stopped early")}</span>}
              </span>
              <span className="disk-bar">
                <span className="disk-fill" style={{ width: `${e.bytes > 0 && max > 0 ? Math.max(1.5, (e.bytes / max) * 100) : 0}%` }} />
              </span>
            </button>
            <span className="disk-size">
              {e.partial ? tx("at least ") : ''}
              {formatBytes(e.bytes)}
              <span className="disk-share">{shareText(e.bytes, data.total)}</span>
            </span>
            <button className="link" onClick={() => api.invoke('disk:open', e).catch(() => {})} title={tx("Open {p0} in Explorer", { p0: (e.dir ? 'this folder' : "this file's folder") })}>{tx("Open")}</button>
          </div>
        ))}
      </div>
    </div>
  );
}
