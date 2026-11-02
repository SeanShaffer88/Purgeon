import { tx } from './backend/i18n.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { cleanupItems } from './backend/junk.js';
import { formatBytes } from './format.js';

export { formatBytes };

const api = window.api;

// Junk Files: scans the known junk folders and cleans the chosen categories to the Recycle Bin.
export function JunkView({ filter, admin, onError, onStatus, onClean }) {
  const [cats, setCats] = useState(null);
  const [chosen, setChosen] = useState(new Set());
  const [open, setOpen] = useState(null);
  // Windows' own clean-ups: permanent, so never selected by default.
  const [system, setSystem] = useState(null);
  const [chosenSys, setChosenSys] = useState(new Set());
  const [scanRun, setScanRun] = useState(0);
  const [scanCancelled, setScanCancelled] = useState(false);
  const cancelRef = useRef(false);

  useEffect(() => {
    setScanCancelled(false);
    cancelRef.current = false;
    setCats(null);
    setSystem(null);
    api
      .invoke('junk:scan')
      .then((c) => {
        if (cancelRef.current) return; // a cancelled scan's late results are discarded
        setCats(c);
        // Everything found is selected, except what needs administrator rights when not elevated.
        setChosen(new Set(c.filter((x) => x.items.length && !x.privacy && !(x.admin && admin === false)).map((x) => x.id)));
      })
      .catch((e) => {
        onError(e.message);
        setCats([]);
      });
    api
      .invoke('junk:scanSystem')
      .then(setSystem)
      .catch(() => setSystem([]));
  }, [scanRun]);

  const cancelScan = () => {
    cancelRef.current = true;
    api.invoke('junk:scanCancel').catch(() => {});
    setScanCancelled(true);
    setCats([]);
    setSystem([]);
  };

  const picked = (cats || []).filter((c) => chosen.has(c.id));
  const total = picked.reduce((n, c) => n + c.bytes, 0);
  const count = picked.reduce((n, c) => n + c.items.length, 0);
  const sysPicked = (system || []).filter((c) => chosenSys.has(c.id));

  useEffect(() => {
    if (!cats) return onStatus('Scanning for junk files');
    const all = cats.reduce((n, c) => n + c.bytes, 0);
    onStatus(`${formatBytes(all)} of junk files found, ${formatBytes(total)} selected`);
  }, [cats, total]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (cats || []).filter((c) => !q || `${tx(c.label)} ${tx(c.detail)}`.toLowerCase().includes(q));
  }, [cats, filter]);

  const toggle = (id) =>
    setChosen((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  if (scanCancelled) return (
    <div className="list-empty-actionable">
      <div>{tx("Scan cancelled — nothing was cleaned.")}</div>
      <button className="btn" onClick={() => setScanRun((n) => n + 1)}>{tx("Scan Again")}</button>
    </div>
  );
  if (!cats) return (
    <div className="list-empty-actionable">
      <div>{tx("Scanning temporary files, crash dumps and caches…")}</div>
      <button className="btn" onClick={cancelScan}>{tx("Cancel Scan")}</button>
    </div>
  );

  return (
    <div className="debloat junk">
      <div className="debloat-bar">
        <span className="legend">{tx("Temporary files, crash dumps, error reports and caches that Windows and programs recreate when needed. The registry is not touched.")}</span>
        <span className="debloat-actions">
          <button className="restart-explorer" disabled={!count && !sysPicked.length} onClick={() => onClean(cleanupItems(picked), picked, total, sysPicked)}>{tx("Clean ")}{count ? `${formatBytes(total)}` : tx("Selected")}
            {sysPicked.length ? tx(" + {p0} Windows clean-up{p1}", { p0: (sysPicked.length), p1: (sysPicked.length === 1 ? '' : 's') }) : ''}
          </button>
        </span>
      </div>
      {shown.length === 0 && <div className="list-empty">{tx("No categories match.")}</div>}
      <section className="tweak-group">
        {shown.map((c) => {
          const needsAdmin = c.admin && admin === false;
          return (
            <div key={c.id}>
              <label className={`tweak junk-row ${chosen.has(c.id) ? 'on' : 'off'} ${c.items.length ? '' : 'empty'}`}>
                <input type="checkbox" checked={chosen.has(c.id)} disabled={!c.items.length} onChange={() => toggle(c.id)} />
                <span className="tweak-text">
                  <span className="tweak-title">{tx(c.label)}</span>
                  <span className="tweak-detail">{tx(c.detail)}</span>
                </span>
                <span className="tweak-tags">
                  <span className="junk-size">{c.items.length ? formatBytes(c.bytes) : tx("Clean")}</span>
                  {c.items.length > 0 && (
                    <button
                      className="link junk-count"
                      onClick={(e) => {
                        e.preventDefault();
                        setOpen(open === c.id ? null : c.id);
                      }}
                    >
                      {c.items.length.toLocaleString()}{tx(" item")}{c.items.length === 1 ? '' : tx("s")} {open === c.id ? '▴' : '▾'}
                    </button>
                  )}
                  {c.admin && <span className={`fx fx-admin ${needsAdmin ? 'warn' : ''}`} title={needsAdmin ? tx("Restart as Administrator to clean this") : undefined}>{tx("Admin")}</span>}
                </span>
              </label>
              {open === c.id && (
                <div className="junk-items">
                  {[...c.items]
                    .sort((a, b) => b.bytes - a.bytes)
                    .slice(0, 300)
                    .map((i) => (
                      <div key={i.path} className="junk-item">
                        <span className="path">{i.path}</span>
                        <span className="muted">{formatBytes(i.bytes)}</span>
                      </div>
                    ))}
                  {c.items.length > 300 && <div className="muted junk-item">{tx("…and ")}{(c.items.length - 300).toLocaleString()}{tx(" more")}</div>}
                </div>
              )}
            </div>
          );
        })}
      </section>
      <section className="tweak-group">
        <div className="tweak-group-head">
          <span>{tx("Windows clean-up · permanent")}</span>
          <span className="muted">{tx("done by Windows itself; cannot be undone")}</span>
        </div>
        {!system && <div className="list-empty">{tx("Checking Windows clean-up options…")}</div>}
        {(system || []).map((c) => {
          const usable = c.present && admin !== false;
          return (
            <label key={c.id} className={`tweak junk-row system ${chosenSys.has(c.id) ? 'on' : 'off'} ${usable ? '' : 'empty'}`}>
              <input
                type="checkbox"
                checked={chosenSys.has(c.id)}
                disabled={!usable}
                onChange={() =>
                  setChosenSys((s) => {
                    const n = new Set(s);
                    n.has(c.id) ? n.delete(c.id) : n.add(c.id);
                    return n;
                  })
                }
              />
              <span className="tweak-text">
                <span className="tweak-title">{tx(c.label)}</span>
                <span className="tweak-detail">{tx(c.detail)}</span>
              </span>
              <span className="tweak-tags">
                <span className="junk-size">{!c.present ? tx("Nothing to clean") : c.bytes != null ? formatBytes(c.bytes) : c.note}</span>
                <span className="fx fx-permanent">{tx("Permanent")}</span>
                <span className={`fx fx-admin ${admin === false ? 'warn' : ''}`} title={admin === false ? tx("Restart as Administrator to use this") : undefined}>{tx("Admin")}</span>
              </span>
            </label>
          );
        })}
      </section>
      <p className="footnote junk-note">{tx("Cleaned items go to the Recycle Bin, so you can undo a cleanup from Tools › Change History. Empty the Recycle Bin afterwards to free the space. Files in use are skipped.")}</p>
    </div>
  );
}
