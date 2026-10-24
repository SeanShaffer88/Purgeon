import { useMemo, useState } from 'react';
import { Dialog, PlanView } from './dialogs.jsx';
import { PRESETS, revertible } from './backend/snapshots.js';

const defaultName = () => {
  const d = new Date();
  return `Snapshot ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${d.toTimeString().slice(0, 5)}`;
};

export function TakeSnapshotDialog({ onTake, onClose }) {
  const [name, setName] = useState(defaultName);
  const [preset, setPreset] = useState('standard');
  return (
    <Dialog
      title="Take a Snapshot"
      onClose={onClose}
      width={560}
      buttons={
        <>
          <button className="primary" disabled={!name.trim()} onClick={() => onTake(name.trim(), preset)}>
            Take Snapshot
          </button>
          <button onClick={onClose}>Cancel</button>
        </>
      }
    >
      <p className="heading">A snapshot records the files, folders and registry settings programs use, so you can later see exactly what changed.</p>
      <label className="field">
        Name
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && onTake(name.trim(), preset)} />
      </label>
      <div className="field">
        Depth
        <div className="preset-row">
          {Object.entries(PRESETS).map(([id, p]) => (
            <label key={id} className={`preset ${preset === id ? 'on' : ''}`}>
              <input type="radio" name="preset" checked={preset === id} onChange={() => setPreset(id)} />
              <b>{p.label}</b>
              <span className="muted">
                {p.fileDepth} folder levels · {p.hint}
              </span>
            </label>
          ))}
        </div>
      </div>
      <p className="footnote">Covers Program Files, ProgramData, AppData, the Start Menu and desktops, plus the software and services parts of the registry. Temporary files and caches are left out.</p>
    </Dialog>
  );
}

const GROUPS = [
  ['added', 'Added'],
  ['removed', 'Removed'],
  ['changed', 'Changed'],
];
const isRegistry = (c) => c.kind === 'key' || c.kind === 'value';
const fmtSize = (b) => {
  const n = Number(b);
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
};
const short = (s) => {
  const t = String(s ?? '').replace(/\\0/g, ' | ');
  return t.length > 48 ? `${t.slice(0, 45)}…` : t;
};

// Whether a difference can be cleaned up: added items are removed; registry values and keys
// that changed or were removed are put back from the earlier snapshot.
export function cleanable(c) {
  if (c.group === 'added') return true;
  if (c.kind === 'value') return revertible(c.valueType, c.before);
  return c.group === 'removed' && c.kind === 'key';
}

function describe(c) {
  if (c.kind === 'value') {
    const v = `${c.path}  ›  ${c.name || '(default)'}`;
    if (c.group === 'changed') return [v, `${short(c.before)}  →  ${short(c.after)}`];
    return [v, short(c.group === 'added' ? c.after : c.before)];
  }
  if (c.kind === 'file' && c.group === 'changed') return [c.path, `${fmtSize(c.before)} → ${fmtSize(c.after)}`];
  if (c.kind === 'file') return [c.path, fmtSize(c.after)];
  return [c.path, ''];
}

const PAGE = 400;

export function ComparisonDialog({ comparison, beforeName, afterName, onCleanup, onExport, onDryRun, onExportPlan, onClose }) {
  const [plan, setPlan] = useState(null);
  const [planning, setPlanning] = useState(false);
  const all = useMemo(() => {
    const out = {};
    for (const [g] of GROUPS) out[g] = comparison[g].map((c, i) => ({ ...c, group: g, id: `${g}:${i}` }));
    return out;
  }, [comparison]);
  const [tab, setTab] = useState(() => GROUPS.find(([g]) => comparison[g].length)?.[0] || 'added');
  const [kinds, setKinds] = useState({ files: true, registry: true });
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState(PAGE);
  const [selected, setSelected] = useState(() => new Set());

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all[tab].filter((c) => (isRegistry(c) ? kinds.registry : kinds.files) && (!q || `${c.path} ${c.name || ''}`.toLowerCase().includes(q)));
  }, [all, tab, kinds, query]);
  const selectable = rows.filter(cleanable);
  const chosen = Object.values(all)
    .flat()
    .filter((c) => selected.has(c.id));

  const toggle = (id) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  const setMany = (list, on) =>
    setSelected((s) => {
      const n = new Set(s);
      list.forEach((c) => (on ? n.add(c.id) : n.delete(c.id)));
      return n;
    });

  return (
    <Dialog
      title={`Compare · ${beforeName}  →  ${afterName}`}
      onClose={onClose}
      width={900}
      buttons={
        <>
          <span className="button-hint">{chosen.length} selected</span>
          <button onClick={() => setMany(selectable, true)}>Select Shown</button>
          <button onClick={() => setSelected(new Set())}>Select None</button>
          <button onClick={() => onExport(all)}>Export…</button>
          {onDryRun && (
            <button
              disabled={!chosen.length || planning}
              title="Check what the cleanup would do, without changing anything"
              onClick={async () => {
                setPlanning(true);
                try {
                  setPlan(await onDryRun(chosen));
                } finally {
                  setPlanning(false);
                }
              }}
            >
              {planning ? 'Checking…' : 'Dry Run'}
            </button>
          )}
          <button className="primary" disabled={!chosen.length} onClick={() => onCleanup(chosen)}>
            Clean Up Selected
          </button>
          <button onClick={onClose}>Close</button>
        </>
      }
    >
      <div className="compare-tabs" role="tablist">
        {GROUPS.map(([g, label]) => (
          <button key={g} role="tab" aria-selected={tab === g} className={`compare-tab ${g} ${tab === g ? 'on' : ''}`} onClick={() => (setTab(g), setShown(PAGE))}>
            {label} <span className="count">{comparison[g].length.toLocaleString()}</span>
          </button>
        ))}
        <span className="compare-filters">
          <label>
            <input type="checkbox" checked={kinds.files} onChange={(e) => setKinds((k) => ({ ...k, files: e.target.checked }))} /> Files
          </label>
          <label>
            <input type="checkbox" checked={kinds.registry} onChange={(e) => setKinds((k) => ({ ...k, registry: e.target.checked }))} /> Registry
          </label>
          <input className="compare-search" placeholder="Filter" value={query} onChange={(e) => (setQuery(e.target.value), setShown(PAGE))} />
        </span>
      </div>
      {comparison.truncated && <div className="error-box">This comparison is very large; only the first part of each list is shown.</div>}
      {plan && <PlanView results={plan} onBack={() => setPlan(null)} onExport={() => onExportPlan(plan)} />}
      <div className="tree compare-list" hidden={!!plan}>
        {rows.length === 0 && <div className="empty-box">No differences here.</div>}
        {rows.slice(0, shown).map((c) => {
          const [main, extra] = describe(c);
          const can = cleanable(c);
          return (
            <label key={c.id} className={`tree-item compare-row ${can ? '' : 'info'}`} title={can ? undefined : 'Shown for information: file contents are not stored in snapshots, so this cannot be put back.'}>
              <input type="checkbox" disabled={!can} checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
              <span className={`kind kind-${c.kind}`} />
              <span className="path">{main}</span>
              {extra && <span className="compare-extra">{extra}</span>}
            </label>
          );
        })}
        {rows.length > shown && (
          <button className="link show-more" onClick={() => setShown((n) => n + PAGE * 2)}>
            Show more ({(rows.length - shown).toLocaleString()} left)
          </button>
        )}
      </div>
      <p className="footnote">
        Clean up removes selected <b>added</b> items and puts back selected <b>changed</b> or <b>removed</b> registry values and keys from the earlier snapshot. Everything is backed up first and can be undone from Tools › Change History. Changed or removed files are shown for information only.
      </p>
    </Dialog>
  );
}

// A standalone HTML report of a comparison.
export function comparisonHtml(all, beforeName, afterName) {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const section = (g, label) =>
    `<h2>${label} (${all[g].length})</h2><table><tr><th>Type</th><th>Path</th><th>Details</th></tr>${all[g]
      .map((c) => {
        const [main, extra] = describe(c);
        return `<tr><td>${c.kind}</td><td>${esc(main)}</td><td>${esc(extra)}</td></tr>`;
      })
      .join('')}</table>`;
  return `<!doctype html><meta charset="utf-8"><title>Snapshot comparison</title>
<style>body{font:13px Segoe UI,sans-serif;margin:24px}table{border-collapse:collapse;width:100%;margin-bottom:24px}th,td{text-align:left;padding:3px 8px;border-bottom:1px solid #ddd;vertical-align:top}th{background:#f3f3f3}td:first-child{white-space:nowrap}</style>
<h1>Snapshot comparison</h1><p>${esc(beforeName)} → ${esc(afterName)} · exported ${new Date().toLocaleString()}</p>
${GROUPS.map(([g, l]) => section(g, l)).join('\n')}`;
}

// A timeline of saved snapshots, ending at "Now". Click a snapshot to select it, Ctrl+click a
// second one; then compare the two, or the selected one with now.
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
    <div className="timeline" role="group" aria-label="Snapshot timeline">
      <div className="timeline-track">
        <span className="timeline-line" />
        {sorted.map((s, i) => (
          <button
            key={s.key}
            className={`timeline-dot ${marked.has(s.key) ? 'on' : ''}`}
            style={{ left: `${left(i)}%`, maxWidth: width }}
            title={`${s.name}\n${new Date(s.created).toLocaleString()}\nClick to select, Ctrl+click to select a second one`}
            onClick={(e) => onSelect(s.key, e.ctrlKey || e.metaKey)}
          >
            <span className="timeline-label">{s.name}</span>
            <span className="timeline-date">{day(s.created)}</span>
          </button>
        ))}
        <button className="timeline-dot now" style={{ left: '95%' }} disabled={chosen.length !== 1} onClick={() => onCompareNow(chosen[0])} title="Compare the selected snapshot with the system now">
          <span className="timeline-label">Now</span>
          <span className="timeline-date">{day(new Date(now).toISOString())}</span>
        </button>
      </div>
      <div className="timeline-hint">
        {chosen.length === 2 ? (
          <button className="link" onClick={() => onCompare(chosen[0], chosen[1])}>
            Compare “{chosen[0].name}” → “{chosen[1].name}”
          </button>
        ) : chosen.length === 1 ? (
          <span>Ctrl+click a second snapshot to compare the two, or click Now.</span>
        ) : (
          <span>Click a snapshot to select it.</span>
        )}
      </div>
    </div>
  );
}
