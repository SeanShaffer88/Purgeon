import { tx } from './backend/i18n.js';

export function SnapshotTimeline({ snapshots, marked, onSelect, onCompare, onCompareNow }) {
  // Rows of another list can arrive for one render while the view switches; only snapshots count.
  snapshots = snapshots.filter((s) => s && typeof s.created === 'string');
  if (!snapshots.length) return null;
  const sorted = [...snapshots].sort((a, b) => a.created.localeCompare(b.created));
  const now = Date.now();
  // Evenly spaced in date order, so dots and labels never overlap however close in time they are.
  const step = 86 / Math.max(sorted.length, 1);
  const left = (i) => 3 + step * i + step / 2;
  const width = `${Math.min(18, step - 0.5)}%`;
  const chosen = sorted.filter((s) => marked.has(s.key));
  const day = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return (
    <div className="snapshot-timeline" role="group" aria-label={tx("Snapshot timeline")}>
      <div className="timeline-track">
        <span className="timeline-line" />
        {sorted.map((s, i) => (
          <button
            key={s.key}
            className={`timeline-dot ${marked.has(s.key) ? 'on' : ''}`}
            style={{ left: `${left(i)}%`, maxWidth: width }}
            title={tx("{p0}\n{p1}\nClick to select, Ctrl+click to select a second one", { p0: (s.name), p1: (new Date(s.created).toLocaleString()) })}
            onClick={(e) => onSelect(s.key, e.ctrlKey || e.metaKey)}
          >
            <span className="timeline-label">{s.name}</span>
            <span className="timeline-date">{day(s.created)}</span>
          </button>
        ))}
        <button className="timeline-dot now" style={{ left: '95%' }} disabled={chosen.length !== 1} onClick={() => onCompareNow(chosen[0])} title={tx("Compare the selected snapshot with the system now")}>
          <span className="timeline-label">{tx("Now")}</span>
          <span className="timeline-date">{day(new Date(now).toISOString())}</span>
        </button>
      </div>
      <div className="timeline-hint">
        {chosen.length === 2 ? (
          <button className="link" onClick={() => onCompare(chosen[0], chosen[1])}>{tx("Compare “")}{chosen[0].name}” → “{chosen[1].name}”
          </button>
        ) : chosen.length === 1 ? (
          <span>{tx("Ctrl+click a second snapshot to compare the two, or click Now.")}</span>
        ) : (
          <span>{tx("Click a snapshot to select it.")}</span>
        )}
      </div>
    </div>
  );
}
