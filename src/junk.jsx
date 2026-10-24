import { useEffect, useMemo, useState } from 'react';
import { cleanupItems } from './backend/junk.js';

const api = window.api;

export const formatBytes = (b) => {
  if (!b) return '0 B';
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB`;
  return `${(b / 1073741824).toFixed(2)} GB`;
};

// Junk Files: scans the known junk folders and cleans the chosen categories to the Recycle Bin.
export function JunkView({ filter, admin, onError, onStatus, onClean }) {
  const [cats, setCats] = useState(null);
  const [chosen, setChosen] = useState(new Set());
  const [open, setOpen] = useState(null);

  useEffect(() => {
    api
      .invoke('junk:scan')
      .then((c) => {
        setCats(c);
        // Everything found is selected, except what needs administrator rights when not elevated.
        setChosen(new Set(c.filter((x) => x.items.length && !(x.admin && admin === false)).map((x) => x.id)));
      })
      .catch((e) => {
        onError(e.message);
        setCats([]);
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const picked = (cats || []).filter((c) => chosen.has(c.id));
  const total = picked.reduce((n, c) => n + c.bytes, 0);
  const count = picked.reduce((n, c) => n + c.items.length, 0);

  useEffect(() => {
    if (!cats) return onStatus('Scanning for junk files');
    const all = cats.reduce((n, c) => n + c.bytes, 0);
    onStatus(`${formatBytes(all)} of junk files found, ${formatBytes(total)} selected`);
  }, [cats, total]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (cats || []).filter((c) => !q || `${c.label} ${c.detail}`.toLowerCase().includes(q));
  }, [cats, filter]);

  const toggle = (id) =>
    setChosen((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  if (!cats) return <div className="list-empty">Scanning temporary files, crash dumps and caches…</div>;

  return (
    <div className="debloat junk">
      <div className="debloat-bar">
        <span className="legend">Temporary files, crash dumps, error reports and caches that Windows and programs recreate when needed. The registry is not touched.</span>
        <span className="debloat-actions">
          <button className="restart-explorer" disabled={!count} onClick={() => onClean(cleanupItems(picked), picked, total)}>
            Clean {count ? `${formatBytes(total)}` : 'Selected'}
          </button>
        </span>
      </div>
      {shown.length === 0 && <div className="list-empty">No categories match.</div>}
      <section className="tweak-group">
        {shown.map((c) => {
          const needsAdmin = c.admin && admin === false;
          return (
            <div key={c.id}>
              <label className={`tweak junk-row ${chosen.has(c.id) ? 'on' : 'off'} ${c.items.length ? '' : 'empty'}`}>
                <input type="checkbox" checked={chosen.has(c.id)} disabled={!c.items.length} onChange={() => toggle(c.id)} />
                <span className="tweak-text">
                  <span className="tweak-title">{c.label}</span>
                  <span className="tweak-detail">{c.detail}</span>
                </span>
                <span className="tweak-tags">
                  <span className="junk-size">{c.items.length ? formatBytes(c.bytes) : 'Clean'}</span>
                  {c.items.length > 0 && (
                    <button
                      className="link junk-count"
                      onClick={(e) => {
                        e.preventDefault();
                        setOpen(open === c.id ? null : c.id);
                      }}
                    >
                      {c.items.length.toLocaleString()} item{c.items.length === 1 ? '' : 's'} {open === c.id ? '▴' : '▾'}
                    </button>
                  )}
                  {c.admin && <span className={`fx fx-admin ${needsAdmin ? 'warn' : ''}`} title={needsAdmin ? 'Restart as Administrator to clean this' : undefined}>Admin</span>}
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
                  {c.items.length > 300 && <div className="muted junk-item">…and {(c.items.length - 300).toLocaleString()} more</div>}
                </div>
              )}
            </div>
          );
        })}
      </section>
      <p className="footnote junk-note">Cleaned items go to the Recycle Bin, so you can undo a cleanup from Tools › Change History. Empty the Recycle Bin afterwards to free the space. Files in use are skipped.</p>
    </div>
  );
}
