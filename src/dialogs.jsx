import { useMemo, useState, useEffect, useRef } from 'react';
import { SettingHelp } from './onboarding.jsx';

const api = window.api;

export function Dialog({ title, onClose, children, buttons, width = 520 }) {
  const dialogRef = useRef(null);
  // The latest onClose, read by the mount-once keyboard listener below. (With an
  // inline onClose from the parent, an [onClose]-keyed effect re-ran on every
  // parent render and stole focus back to the dialog container each time —
  // including right after another layer, like the command palette, had opened
  // and focused its input.)
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    // Focus the dialog container on open so keyboard users land in the modal.
    const el = dialogRef.current;
    if (el) el.focus();
    const onKey = (e) => {
      // Only the topmost layer answers the keyboard: when dialogs stack, Escape
      // closes them one at a time from the top instead of every dialog at once.
      // The topmost layer is the last dialog in the document (equal z-index,
      // later in the tree paints on top). The command palette counts as a layer
      // too, even though it is not a Dialog, so a dialog never closes from
      // behind an open palette.
      const layers = document.querySelectorAll('.dialog, .palette');
      if (!el || layers[layers.length - 1] !== el) return;
      if (e.key === 'Escape') { onCloseRef.current && onCloseRef.current(); }
      else if (e.key === 'Enter') {
        // Activate the primary button if focused element is not a button/input.
        const active = document.activeElement;
        const isButtonOrInput = /^(BUTTON|INPUT|TEXTAREA|SELECT)$/.test(active?.tagName || '');
        if (!isButtonOrInput) {
          const primary = el.querySelector('button.primary');
          if (primary) primary.click();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div className="overlay">
      <div className="dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined} tabIndex="-1" style={{ width, maxWidth: '96vw' }}>
        <div className="dialog-title">
          <span>{title}</span>
          {onClose && (
            <button className="title-close" onClick={onClose} aria-label="Close">
              ✕
            </button>
          )}
        </div>
        <div className="dialog-body">{children}</div>
        {buttons && <div className="dialog-buttons">{buttons}</div>}
      </div>
    </div>
  );
}

// Yes/No question, optionally with a checkbox (such as "Create a restore point first").
// Yes/No question, optionally with checkboxes ("Create a restore point first" and/or "Don't show again").
export function ConfirmDialog({ message, detail, checkboxLabel, checkboxChecked, confirmId, dontShowLabel, onAnswer }) {
  const [checked, setChecked] = useState(!!checkboxChecked);
  const [dontShow, setDontShow] = useState(false);
  const handleAnswer = (ok) => {
    if (confirmId && dontShow) {
      api.invoke('settings:get').then((s) => {
        const disabled = Array.isArray(s.disabledConfirmations) ? [...s.disabledConfirmations] : [];
        if (!disabled.includes(confirmId)) disabled.push(confirmId);
        return api.invoke('settings:set', { disabledConfirmations: disabled });
      }).catch(() => {});
    }
    onAnswer({ ok, checked, dontShow });
  };
  return (
    <Dialog
      title="Purgeon"
      onClose={() => handleAnswer(false)}
      width={500}
      buttons={
        <>
          <button className="primary" autoFocus onClick={() => handleAnswer(true)}>Yes</button>
          <button onClick={() => handleAnswer(false)}>No</button>
        </>
      }
    >
      <p className="heading">{message}</p>
      {detail && <p className="confirm-detail">{detail}</p>}
      {checkboxLabel && (
        <label className="confirm-check">
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
          {checkboxLabel}
        </label>
      )}
      {confirmId && (
        <label className="confirm-check">
          <input type="checkbox" checked={dontShow} onChange={(e) => setDontShow(e.target.checked)} />
          {dontShowLabel || 'Don\'t show again'}
        </label>
      )}
    </Dialog>
  );
}

export function Busy({ busy, onStop, onPause, onCancel }) {
  // Accept either a string message or a rich busy object.
  const msg = typeof busy === 'string' ? busy : busy?.message || '';
  const progress = typeof busy === 'object' ? busy.progress : null;
  const elapsed = typeof busy === 'object' ? busy.elapsed : null;
  const current = typeof busy === 'object' ? busy.current : null;
  const total = typeof busy === 'object' ? busy.total : null;
  const canPause = typeof busy === 'object' ? !!busy.canPause : false;
  const canCancel = typeof busy === 'object' ? !!busy.canCancel : false;

  const [stopping, setStopping] = useState(false);
  const [paused, setPaused] = useState(false);
  const startTime = useRef(Date.now());

  const pct = progress != null ? progress : (current != null && total ? Math.round((current / total) * 100) : null);
  const displayElapsed = elapsed != null ? elapsed : Math.floor((Date.now() - startTime.current) / 1000);
  const timeText = displayElapsed > 0 ? ` (${displayElapsed}s)` : '';

  return (
    <div className="overlay">
      <div className="dialog busy" style={{ width: 480 }} aria-live="polite" aria-label="Busy">
        <div className="dialog-body">
          <div className="busy-msg">{msg}{timeText}</div>
          {pct != null && (
            <>
              <div className="progress">
                <div className="progress-bar" style={{ width: `${pct}%` }} />
              </div>
              <div className="progress-text">
                {current != null && total ? `${current} of ${total}` : ''}
                {pct != null ? ` · ${pct}%` : ''}
              </div>
            </>
          )}
          {paused && <div className="busy-paused">Paused</div>}
        </div>
        <div className="dialog-buttons">
          {canPause && (
            <button
              disabled={stopping}
              onClick={() => {
                setPaused((p) => !p);
                if (onPause) onPause(!p);
              }}
            >
              {paused ? 'Resume' : 'Pause'}
            </button>
          )}
          {(onStop || canCancel) && (
            <button
              disabled={stopping}
              onClick={() => {
                setStopping(true);
                if (onStop) onStop();
                if (onCancel) onCancel();
              }}
            >
              {stopping ? 'Stopping…' : canCancel ? 'Cancel' : 'Stop After This One'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const GROUPS = [
  { id: 'registry', label: 'Registry', kinds: ['key', 'value', 'createkey', 'setvalue'] },
  { id: 'files', label: 'Files and Folders', kinds: ['dir', 'file', 'junk'] },
  { id: 'services', label: 'Services', kinds: ['service'] },
  { id: 'tasks', label: 'Scheduled Tasks', kinds: ['task'] },
  { id: 'firewall', label: 'Firewall Rules', kinds: ['firewall'] },
];

const itemLabel = (i) =>
  i.kind === 'value'
    ? `${i.path}  ›  ${i.name}`
    : i.kind === 'service'
      ? `Service: ${i.path}`
      : i.kind === 'task'
        ? `Task: ${i.path}`
        : i.kind === 'firewall'
          ? `Firewall: ${i.name || i.path}`
          : i.kind === 'setvalue'
            ? `Put back: ${i.path}  ›  ${i.name || '(default)'}`
            : i.kind === 'createkey'
              ? `Recreate: ${i.path}`
              : i.path;

// Safe mode offers only near-certain matches and never services, tasks or firewall rules.
export const safeAllowed = (it, safeMode) => !safeMode || ((typeof it.score === 'number' ? it.score : it.confidence === 'high' ? 80 : 40) >= 90 && !['service', 'task', 'firewall'].includes(it.kind));

// A dry run's results: what would happen to each selected item, with nothing changed.
export function PlanView({ results, onBack, onExport }) {
  const skipped = results.filter((r) => !r.ok);
  return (
    <div className="plan">
      <div className="plan-bar">
        <b>Dry run · nothing was changed.</b>
        <span className="muted">
          {results.length - skipped.length} would be removed or put back{skipped.length ? `, ${skipped.length} would be skipped` : ''}.
        </span>
        <span className="plan-actions">
          <button onClick={onExport}>Export Plan…</button>
          <button onClick={onBack}>Back to the List</button>
        </span>
      </div>
      <div className="tree">
        {[...skipped, ...results.filter((r) => r.ok)].slice(0, 800).map((r, i) => (
          <div key={i} className={`result ${r.ok ? 'ok' : 'fail'}`}>
            <span className="mark">{r.ok ? '→' : '–'}</span>
            <span className="path">{itemLabel(r)}</span>
            <span className="muted">{r.detail}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function planHtml(title, results) {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  return `<!doctype html><meta charset="utf-8"><title>Dry run</title>
<style>body{font:13px Segoe UI,sans-serif;margin:24px}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:3px 8px;border-bottom:1px solid #ddd;vertical-align:top}th{background:#f3f3f3}.no{color:#a33}</style>
<h1>Dry run: ${esc(title)}</h1><p>Exported ${new Date().toLocaleString()}. Nothing was changed.</p>
<table><tr><th>Type</th><th>Item</th><th>What would happen</th></tr>${results.map((r) => `<tr class="${r.ok ? '' : 'no'}"><td>${esc(r.kind)}</td><td>${esc(itemLabel(r))}</td><td>${esc(r.detail)}</td></tr>`).join('')}</table>`;
}

export function LeftoversDialog({ title, heading, items, onClose, onRemove, onDryRun, onExportPlan, safeMode = false }) {
  const allowed = (it) => safeAllowed(it, safeMode);
  const [checked, setChecked] = useState(() => new Set(items.map((it, idx) => (it.confidence === 'high' && allowed(it) ? idx : -1)).filter((i) => i >= 0)));
  const [plan, setPlan] = useState(null);
  const [planning, setPlanning] = useState(false);
  const hidden = items.filter((it) => !allowed(it)).length;
  const [collapsed, setCollapsed] = useState(new Set());
  // Batch results carry `program`; those are grouped by program first, then by type.
  const programs = useMemo(() => [...new Set(items.map((it) => it.program || ''))], [items]);
  const byProgram = programs.length > 1 || programs[0] !== '';
  const sections = useMemo(
    () =>
      programs.map((program) => {
        const groups = GROUPS.map((g) => ({
          ...g,
          id: `${program}|${g.id}`,
          rows: items.map((it, idx) => ({ it, idx })).filter(({ it }) => (it.program || '') === program && g.kinds.includes(it.kind)),
        })).filter((g) => g.rows.length);
        return { program, groups, rows: groups.flatMap((g) => g.rows) };
      }),
    [items, programs]
  );
  const toggle = (idx) =>
    setChecked((s) => {
      const n = new Set(s);
      n.has(idx) ? n.delete(idx) : n.add(idx);
      return n;
    });
  const toggleGroup = (g) =>
    setChecked((s) => {
      const n = new Set(s);
      const all = g.rows.every(({ idx }) => n.has(idx));
      g.rows.forEach(({ idx }) => (all ? n.delete(idx) : n.add(idx)));
      g.rows.forEach(({ idx }) => !allowed(items[idx]) && n.delete(idx));
      return n;
    });
  const selected = () => items.filter((_, i) => checked.has(i));
  const dryRun = async () => {
    setPlanning(true);
    try {
      setPlan(await onDryRun(selected()));
    } finally {
      setPlanning(false);
    }
  };

  return (
    <Dialog
      title={title}
      onClose={onClose}
      width={680}
      buttons={
        <>
          <span className="button-hint">{checked.size} of {items.length} selected</span>
          <button onClick={() => setChecked(new Set(items.map((_, i) => i).filter((i) => allowed(items[i]))))}>Select All</button>
          <button onClick={() => setChecked(new Set())}>Select None</button>
          {onDryRun && (
            <button disabled={!checked.size || planning} onClick={dryRun} title="Check what would happen, without changing anything">
              {planning ? 'Checking…' : 'Dry Run'}
            </button>
          )}
          <button className="primary" disabled={!checked.size} onClick={() => onRemove(selected())}>
            Delete Selected
          </button>
          <button onClick={onClose}>Close</button>
        </>
      }
    >
      <p className="heading">{heading}</p>
      {safeMode && hidden > 0 && <div className="safe-note">Safe mode: {hidden} lower-confidence item{hidden === 1 ? ' is' : 's are'} shown but can’t be selected. Turn it off in Tools › Safe Mode.</div>}
      {plan ? (
        <PlanView results={plan} onBack={() => setPlan(null)} onExport={() => onExportPlan(plan)} />
      ) : items.length === 0 ? (
        <div className="empty-box">No leftovers found. Everything was removed cleanly.</div>
      ) : (
        <div className="tree">
          {sections.map((s) => [
            byProgram && (
              <div key={`p|${s.program}`} className="tree-program">
                <input
                  type="checkbox"
                  checked={s.rows.every(({ idx }) => checked.has(idx))}
                  ref={(el) => el && (el.indeterminate = !s.rows.every(({ idx }) => checked.has(idx)) && s.rows.some(({ idx }) => checked.has(idx)))}
                  onChange={() => toggleGroup(s)}
                />
                <b>{s.program}</b> <span className="muted">({s.rows.length})</span>
              </div>
            ),
            ...s.groups.map((g) => {
            const all = g.rows.every(({ idx }) => checked.has(idx));
            const some = !all && g.rows.some(({ idx }) => checked.has(idx));
            const open = !collapsed.has(g.id);
            return (
              <div key={g.id} className={byProgram ? 'nested' : ''}>
                <div className="tree-group">
                  <button
                    className="twisty"
                    onClick={() =>
                      setCollapsed((s) => {
                        const n = new Set(s);
                        n.has(g.id) ? n.delete(g.id) : n.add(g.id);
                        return n;
                      })
                    }
                  >
                    {open ? '▾' : '▸'}
                  </button>
                  <input type="checkbox" checked={all} ref={(el) => el && (el.indeterminate = some)} onChange={() => toggleGroup(g)} />
                  <b>{g.label}</b> <span className="muted">({g.rows.length})</span>
                </div>
                {open &&
                  g.rows.map(({ it, idx }) => (
                    <label key={idx} className={`tree-item ${it.confidence === 'low' ? 'low' : ''} ${allowed(it) ? '' : 'locked'}`} title={`${it.reason}${typeof it.score === 'number' ? ` · match ${it.score}%` : ''}`}>
                      <input type="checkbox" checked={checked.has(idx)} disabled={!allowed(it)} onChange={() => toggle(idx)} />
                      <span className={`kind kind-${it.kind}`} />
                      <span className="path">{itemLabel(it)}</span>
                      {it.confidence === 'low' && <span className="tag">check</span>}
                      {typeof it.score === 'number' && (
                        <span className={`score ${it.score >= 90 ? 'hi' : it.score >= 70 ? 'mid' : 'lo'}`}>{it.score}%</span>
                      )}
                    </label>
                  ))}
              </div>
            );
            }),
          ])}
        </div>
      )}
      <p className="footnote">Everything you delete is backed up first. Registry entries can be restored from Tools › Backups, and files go to the Recycle Bin.</p>
    </Dialog>
  );
}

// Recovery Packages (Tools › Advanced Tools): every removal backup, whether
// it was proven restorable, and selective restore of single items out of a
// package. Reached only from the menu — nothing here lives in the main window.
const ENTRY_LABEL = {
  file: (e) => e.path,
  dir: (e) => e.path,
  key: (e) => `Registry key — ${e.path}`,
  value: (e) => `${e.path} › ${e.name || '(default)'}`,
  newkey: (e) => `Recreated key — ${e.path}`,
  newvalue: (e) => `Recreated value — ${e.path} › ${e.name || '(default)'}`,
  service: (e) => `Service — ${e.path}`,
  task: (e) => `Scheduled task — ${e.path}`,
  firewall: (e) => `Firewall rule — ${e.name || e.path}`,
};

export function RecoveryDialog({ onClose }) {
  const [packages, setPackages] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [ticked, setTicked] = useState(new Set());
  const [results, setResults] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const load = async (keep) => {
    const list = await api.invoke('backups:list').catch(() => []);
    setPackages(list);
    const sel = list.find((p) => p.id === (keep || selectedId)) || list[0];
    if (sel) {
      setSelectedId(sel.id);
      setTicked(new Set(sel.entries.map((_, i) => i)));
    }
  };
  useEffect(() => {
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const selected = (packages || []).find((p) => p.id === selectedId) || null;
  const pick = (p) => {
    setSelectedId(p.id);
    setResults(null);
    setError('');
    setTicked(new Set(p.entries.map((_, i) => i)));
  };

  const verify = async () => {
    if (!selected) return;
    setBusy('Verifying…');
    setError('');
    try {
      const v = await api.invoke('backups:verifyPackage', selected.id);
      await load(selected.id);
      if (!v.ok) setError(`Verification found problems: ${v.problems.join('; ')}`);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  };

  const restore = async (indexes) => {
    if (!selected || !indexes.length) return;
    setBusy('Restoring…');
    setError('');
    try {
      const out =
        indexes.length === selected.entries.length
          ? await api.invoke('backups:restore', selected.id)
          : await api.invoke('backups:restoreEntries', { id: selected.id, indexes });
      setResults(out);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  };

  const badge = (p) =>
    p.verified === true ? (
      <span className="pkg-badge ok">Restorable ✓ verified</span>
    ) : p.verified === false ? (
      <span className="pkg-badge bad">Verification failed</span>
    ) : (
      <span className="pkg-badge warn">Not verified</span>
    );

  return (
    <Dialog title="Recovery Packages" onClose={onClose} width={880} buttons={<button className="primary" onClick={onClose}>Close</button>}>
      <p className="muted" style={{ marginBottom: 10 }}>
        Backups taken before removals. Each new package is test-restored when it is created, so “Restorable” means it was proven, not hoped.
      </p>
      {error && <div className="error-bar" style={{ marginBottom: 10 }}><span>{error}</span></div>}
      {packages === null ? (
        <p className="muted">Loading…</p>
      ) : packages.length === 0 ? (
        <p className="muted">No backups yet. Backups appear here when something is removed.</p>
      ) : (
        <div className="recovery-cols">
          <div className="pkg-list">
            {packages.map((p) => (
              <button key={p.id} className={`pkg-row ${p.id === selectedId ? 'sel' : ''}`} onClick={() => pick(p)}>
                <span className="pkg-name">{p.title}</span>
                {badge(p)}
              </button>
            ))}
            <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
              <button onClick={verify} disabled={!selected || !!busy} title="Re-check this package: seal, stored files, trial restore, Recycle Bin contents">
                {busy === 'Verifying…' ? 'Verifying…' : 'Verify Selected'}
              </button>
            </div>
            {selected && selected.verified === false && (selected.verifyProblems || []).length > 0 && (
              <ul className="muted" style={{ marginTop: 8, paddingLeft: 16 }}>
                {selected.verifyProblems.map((pr, i) => (
                  <li key={i}>{pr}</li>
                ))}
              </ul>
            )}
          </div>
          <div className="pkg-entries">
            {selected && !results && (
              <>
                <div className="pkg-entries-head">Contents — {selected.title}</div>
                {selected.entries.map((e, i) => (
                  <label key={i} className="pkg-entry">
                    <input
                      type="checkbox"
                      checked={ticked.has(i)}
                      onChange={() => setTicked((t) => { const n = new Set(t); if (n.has(i)) n.delete(i); else n.add(i); return n; })}
                    />
                    <span>{(ENTRY_LABEL[e.kind] || ((x) => x.path))(e)}{e.recycled ? ' (in the Recycle Bin)' : ''}</span>
                  </label>
                ))}
                <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                  <button className="primary" onClick={() => restore([...ticked].sort((a, b) => a - b))} disabled={!ticked.size || !!busy} title="Restore only the ticked items">
                    {busy === 'Restoring…' ? 'Restoring…' : 'Restore Ticked Items'}
                  </button>
                  <button onClick={() => restore(selected.entries.map((_, i) => i))} disabled={!!busy} title="Restore everything in this package">
                    Restore Everything
                  </button>
                </div>
              </>
            )}
            {selected && results && (
              <>
                <div className="pkg-entries-head">Restore results</div>
                {results.map((r, i) => (
                  <div key={i} className="pkg-entry">
                    <span>{r.ok ? '✓' : '✗'} {(ENTRY_LABEL[r.kind] || ((x) => x.path))(r)} <span className="muted">— {r.detail}</span></span>
                  </div>
                ))}
                <div style={{ marginTop: 12 }}>
                  <button onClick={() => setResults(null)}>Back to Contents</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}

// Shared Components (Tools › Advanced Tools): the shared runtimes, folders
// and files Purgeon keeps during removals, with dependents where the system
// records them. Reached only from the menu.
export function SharedDialog({ onClose }) {
  const [items, setItems] = useState(null);
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    api.invoke('shared:components').then(setItems).catch(() => setItems([]));
  }, []);

  const current = items && items.length ? items[Math.min(selected, items.length - 1)] : null;

  return (
    <Dialog title="Shared Components" onClose={onClose} width={880} buttons={<button className="primary" onClick={onClose}>Close</button>}>
      <p className="muted" style={{ marginBottom: 10 }}>
        Parts used by more than one program. These are what Purgeon refuses to delete during a removal — here is exactly why, and who would be affected.
      </p>
      {items === null ? (
        <p className="muted">Loading…</p>
      ) : items.length === 0 ? (
        <p className="muted">No shared components were found on this PC.</p>
      ) : (
        <div className="recovery-cols">
          <div className="pkg-list">
            {items.map((c, i) => (
              <button key={`${c.kind}:${c.path}:${c.name}`} className={`pkg-row ${i === selected ? 'sel' : ''}`} onClick={() => setSelected(i)}>
                <span className="pkg-name">{c.name}</span>
                <span className="muted" style={{ marginLeft: 'auto', flex: 'none' }}>{c.tag}</span>
              </button>
            ))}
          </div>
          <div className="pkg-entries">
            {current && (
              <>
                <div className="pkg-entries-head">{current.kind === 'folder' ? 'Depends on it' : current.kind === 'runtime' ? 'Shared runtime' : 'Shared file'}</div>
                <div className="pkg-entry"><span className="muted">{current.path}</span></div>
                <p style={{ fontSize: 13, margin: '6px 0 10px' }}>{current.detail}</p>
                {current.dependents.map((d) => (
                  <div key={d} className="pkg-entry"><span>{d}</span></div>
                ))}
              </>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}

// Secure Erase (Tools › Advanced Tools): overwrite files, then delete them.
// No backup and no undo — that is the point of the tool — so the list is
// reviewed first and the erase is confirmed in a second step, every time
// (the confirmation cannot be remembered away).
export function EraseDialog({ onClose }) {
  const [files, setFiles] = useState([]);
  const [refused, setRefused] = useState([]);
  const [pattern, setPattern] = useState('zero');
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState(null);
  const [error, setError] = useState('');

  const add = async (folder) => {
    setError('');
    try {
      const picked = await api.invoke('erase:pick', folder);
      if (!picked.length) return;
      const out = await api.invoke('erase:collect', picked);
      setFiles((f) => [...f, ...out.files.filter((n) => !f.some((x) => x.path.toLowerCase() === n.path.toLowerCase()))]);
      setRefused((r) => [...r, ...out.refused]);
    } catch (e) {
      setError(e.message);
    }
  };

  const run = async () => {
    setRunning(true);
    setError('');
    try {
      const out = await api.invoke('erase:run', { files, pattern });
      setResults(out.results);
    } catch (e) {
      setError(e.message);
    } finally {
      setRunning(false);
    }
  };

  const totalBytes = files.reduce((a, f) => a + (f.size || 0), 0);

  return (
    <Dialog title="Secure Erase" onClose={onClose} width={760} buttons={<button className="primary" onClick={onClose}>Close</button>}>
      <p className="muted" style={{ marginBottom: 10 }}>
        Overwrites each file’s contents before deleting it, so the data cannot be undeleted. There is no backup and no undo — that is the point of this tool. Registry items are not offered: overwriting has no meaning there.
      </p>
      {error && <div className="error-bar" style={{ marginBottom: 10 }}><span>{error}</span></div>}
      {!results && !confirming && (
        <>
          <button className="erase-drop" onClick={() => add(false)} title="Choose files to erase">
            Add files to erase…
          </button>
          <div style={{ display: 'flex', gap: 8, margin: '10px 0' }}>
            <button onClick={() => add(false)}>Add Files…</button>
            <button onClick={() => add(true)}>Add Folder…</button>
            {files.length > 0 && <button className="ghost" onClick={() => { setFiles([]); setRefused([]); }}>Clear List</button>}
          </div>
          {files.map((f) => (
            <div key={f.path} className="pkg-entry"><span>{f.path} <span className="muted">{f.size ? `${(f.size / 1048576).toFixed(1)} MB` : ''}</span></span></div>
          ))}
          {refused.map((r) => (
            <div key={r.path} className="pkg-entry"><span className="muted">✗ {r.path} — {r.reason}</span></div>
          ))}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 14 }}>
            <span className="muted">Overwrite:</span>
            <span className="seg">
              {[['zero', '1 pass · zeros'], ['random', '1 pass · random'], ['three', '3 passes']].map(([id, label]) => (
                <button key={id} className={pattern === id ? 'sel' : ''} onClick={() => setPattern(id)}>{label}</button>
              ))}
            </span>
            <span style={{ flex: 1 }} />
            <button className="primary danger" disabled={!files.length} onClick={() => setConfirming(true)} title="Review the list once more, then erase">
              Erase {files.length || ''} File{files.length === 1 ? '' : 's'}…
            </button>
          </div>
          <div className="note" style={{ marginTop: 14 }}>
            Honest limit: on modern SSDs the drive moves data around internally, so overwriting lowers the chance of recovery but cannot promise it. For total certainty, encrypt the drive or destroy it physically.
          </div>
        </>
      )}
      {!results && confirming && (
        <>
          <p style={{ fontSize: 13, marginBottom: 8 }}>
            <strong>This cannot be undone.</strong> {files.length} file{files.length === 1 ? '' : 's'} ({(totalBytes / 1048576).toFixed(1)} MB) will be overwritten and deleted, with no backup:
          </p>
          {files.map((f) => (
            <div key={f.path} className="pkg-entry"><span>{f.path}</span></div>
          ))}
          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <button className="primary danger" onClick={run} disabled={running} title="Overwrite and delete the listed files">
              {running ? 'Erasing…' : 'Confirm Erase'}
            </button>
            {running && <button onClick={() => api.invoke('erase:runCancel')} title="Stop after the current file (a file mid-overwrite is left partially overwritten)">Cancel</button>}
            {!running && <button onClick={() => setConfirming(false)}>Back</button>}
          </div>
        </>
      )}
      {results && (
        <>
          <div className="pkg-entries-head">Erase results</div>
          {results.map((r, i) => (
            <div key={i} className="pkg-entry"><span>{r.ok ? '✓' : '✗'} {r.path} <span className="muted">— {r.detail}</span></span></div>
          ))}
        </>
      )}
    </Dialog>
  );
}

// Games (Tools › Advanced Tools): the games the launchers report, with
// sizes. Uninstalling stays with the launcher; the one fix offered here is
// cleaning up the entry of a game whose files are already gone — and even
// that goes through the standard backed-up removal.
export function GamesDialog({ onClose }) {
  const [games, setGames] = useState(null);
  const [confirming, setConfirming] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');

  const load = () => {
    api.invoke('games:list').then(setGames).catch((e) => { setGames([]); setError(e.message); });
  };
  useEffect(load, []);

  const cleanup = async (g) => {
    if (confirming !== g.entryPath) { setConfirming(g.entryPath); return; }
    setConfirming('');
    setError('');
    try {
      const out = await api.invoke('games:cleanup', g);
      if (out.results?.[0]?.ok) setNote(`The entry for ${g.name} was removed. A backup was made first — restore it from the Archive if you ever need it back.`);
      else setError(out.results?.[0]?.detail || 'The entry could not be removed.');
      load();
    } catch (e) {
      setError(e.message);
    }
  };

  const total = (games || []).reduce((a, g) => a + (g.size || 0), 0);

  return (
    <Dialog title="Games" onClose={onClose} width={760} buttons={<button className="primary" onClick={onClose}>Close</button>}>
      <p className="muted" style={{ marginBottom: 10 }}>
        Games the launchers on this PC report, with the space each one takes. Uninstalling a game stays with its launcher — that is where its files and account live. If a game's files are already gone, Purgeon can clean up the leftover entry, with a backup made first.
      </p>
      {error && <div className="error-bar" style={{ marginBottom: 10 }}><span>{error}</span></div>}
      {note && <div className="note" style={{ marginBottom: 10 }}>{note}</div>}
      {games === null ? (
        <p className="muted">Looking for games…</p>
      ) : games.length === 0 ? (
        <p className="muted">No games were found. Steam, Epic and GOG libraries are checked.</p>
      ) : (
        <>
          {games.map((g) => (
            <div key={`${g.launcher}:${g.entryPath}:${g.name}`} className="pkg-entry">
              <span>
                {g.name} <span className="launcher-chip">{g.launcher}</span>{' '}
                <span className="muted">{g.location}</span>
              </span>
              {g.present ? (
                <span className="muted" style={{ marginLeft: 'auto', flex: 'none' }}>{g.size ? `${(g.size / 1073741824).toFixed(1)} GB${g.partial ? '+' : ''}` : '—'}</span>
              ) : (
                <span style={{ marginLeft: 'auto', flex: 'none', display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span className="pkg-badge warn">files gone</span>
                  <button onClick={() => cleanup(g)} title="Remove this launcher entry — a backup is made first, so it can be restored from the Archive">
                    {confirming === g.entryPath ? 'Confirm cleanup?' : 'Clean Up Entry'}
                  </button>
                </span>
              )}
            </div>
          ))}
          <p className="muted" style={{ marginTop: 10 }}>Total: {(total / 1073741824).toFixed(1)} GB across {games.filter((g) => g.present).length} installed games.</p>
        </>
      )}
    </Dialog>
  );
}

export function ResultsDialog({ title, results, note, onClose, onUndo }) {
  const failed = results.filter((r) => !r.ok);
  return (
    <Dialog
      title={title}
      onClose={onClose}
      width={640}
      buttons={
        <>
          {onUndo && results.some((r) => r.ok) && <button onClick={onUndo}>Undo</button>}
          <button className="primary" onClick={onClose}>
            OK
          </button>
        </>
      }
    >
      <p className="heading">
        {failed.length ? `${results.length - failed.length} of ${results.length} items done, ${failed.length} failed.` : `All ${results.length} items done.`}
      </p>
      <div className="tree">
        {/* Problems first; very long reports (a junk cleanup) show the first 500 rows. */}
        {[...failed, ...results.filter((r) => r.ok)].slice(0, 500).map((r, i) => (
          <div key={i} className={`result ${r.ok ? 'ok' : 'fail'}`}>
            <span className="mark">{r.ok ? '✓' : '✗'}</span>
            <span className="path">{itemLabel(r)}</span>
            <span className="muted">{r.detail}</span>
          </div>
        ))}
        {results.length > 500 && <div className="muted result">…and {(results.length - 500).toLocaleString()} more</div>}
      </div>
      {note && <p className="footnote">{note}</p>}
    </Dialog>
  );
}

export function PropertiesDialog({ program, onClose }) {
  const rows = program.items
    ? [
        ['Name', program.name],
        ['Installer', program.installer],
        ['Monitored', `${new Date(program.started).toLocaleString()} – ${new Date(program.finished).toLocaleString()}`],
        ['Recorded changes', program.items.length],
        ['Uninstall entries', (program.uninstallKeys || []).join('\n')],
      ]
    : [
        ['Name', program.name],
        ['Version', program.version],
        ['Publisher', program.publisher],
        ['Installed on', program.installDate],
        ['Estimated size', program.sizeKB ? `${(program.sizeKB / 1024).toFixed(1)} MB` : ''],
        ['Install location', program.location],
        ['Uninstall command', program.uninstall],
        ['Quiet uninstall', program.quiet],
        ['Registry key', program.store ? '' : program.key],
        ['Package', program.store ? program.key : ''],
        ['Platform', program.arch],
        ['Website', program.urlInfo || program.helpLink],
        ['Signature', signatureText(program.insight)],
        ['Installed together with', program.insight?.together?.join(', ')],
        ['Bundled-offer check', program.insight?.offer ? 'Its name matches a type of program often installed as a bundled offer' : ''],
        ['Size history', sizeText(program.sizes)],
      ];
  return (
    <Dialog title={`Properties – ${program.name}`} onClose={onClose} width={600} buttons={<button className="primary" onClick={onClose}>OK</button>}>
      <table className="props">
        <tbody>
          {rows
            .filter(([, v]) => v !== undefined && v !== null && v !== '')
            .map(([k, v]) => (
              <tr key={k}>
                <th>{k}</th>
                <td>
                  <input readOnly title="Click to select the whole value, then Ctrl+C to copy it" value={String(v)} onFocus={(e) => e.target.select()} />
                </td>
              </tr>
            ))}
        </tbody>
      </table>
      {program.items && (
        <div className="tree" style={{ marginTop: 8, maxHeight: 220 }}>
          {program.items.map((it, i) => (
            <div key={i} className="tree-item">
              <span className={`kind kind-${it.kind}`} />
              <span className="path">{itemLabel(it)}</span>
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}

export const signatureText = (i) =>
  !i?.signature ? '' : i.signature === 'Valid' ? `Signed by ${i.signer || 'a trusted publisher'}` : i.signature === 'NotSigned' ? 'Not signed' : `Signature problem: ${i.signature}${i.signer ? ` (${i.signer})` : ''}`;
const sizeText = (h) =>
  !h || h.length < 2
    ? ''
    : h
        .slice(-6)
        .map(([d, kb]) => `${d}: ${kb < 1048576 ? `${(kb / 1024).toFixed(1)} MB` : `${(kb / 1048576).toFixed(2)} GB`}`)
        .join('   ');

// Tools › Monitor an Installation: before snapshot → user installs → after snapshot → diff.
export function MonitorWizard({ resume, onClose, onRecorded }) {
  const [step, setStep] = useState(resume ? 'installing' : 'pick');
  const [installer, setInstaller] = useState(resume?.installer || '');
  const [name, setName] = useState(() => resume?.name || (resume?.installer ? baseName(resume.installer) : ''));
  const [error, setError] = useState('');
  const [live, setLive] = useState(!!resume?.live);

  const begin = async () => {
    setError('');
    setStep('before');
    try {
      setLive(!!(await api.invoke('monitor:start', installer || null))?.live);
      if (installer) await api.invoke('monitor:launch', installer);
      setStep('installing');
    } catch (e) {
      setError(e.message);
      setStep('pick');
    }
  };
  const finish = async () => {
    setStep('after');
    try {
      const record = await api.invoke('monitor:finish', name.trim());
      onRecorded(record);
    } catch (e) {
      setError(e.message);
      setStep('installing');
    }
  };
  const cancel = async () => {
    if (step === 'installing') await api.invoke('monitor:cancel');
    onClose();
  };

  if (step === 'before') return <Busy message="Taking a snapshot of files and registry before installation…" />;
  if (step === 'after') return <Busy message="Taking the second snapshot and comparing changes…" />;

  return (
    <Dialog
      title="Monitor an Installation"
      onClose={cancel}
      width={560}
      buttons={
        step === 'pick' ? (
          <>
            <button className="primary" onClick={begin}>
              {installer ? 'Start Monitoring' : 'Start (I will run the installer)'}
            </button>
            <button onClick={cancel}>Cancel</button>
          </>
        ) : (
          <>
            <button className="primary" disabled={!name.trim()} onClick={finish}>
              Installation Finished
            </button>
            <button onClick={cancel}>Cancel Monitoring</button>
          </>
        )
      }
    >
      {error && <div className="error-box">{error}</div>}
      {step === 'pick' ? (
        <>
          <p className="heading">Purgeon records every folder, file and registry setting that an installer creates or changes, so the program can be removed completely later. Running as administrator, it also tracks the installer live.</p>
          <ol className="steps">
            <li>Close other programs so their changes aren't recorded.</li>
            <li>Choose the installer. Purgeon takes a snapshot and then starts it.</li>
            <li>When setup is done, come back and click <b>Installation Finished</b>.</li>
          </ol>
          <div className="field-row">
            <input readOnly value={installer} placeholder="No installer chosen" title="The installer to run while monitoring. Use Browse to choose one, or leave it empty and run the installer yourself." />
            <button
              onClick={async () => {
                const f = await api.invoke('monitor:pickInstaller');
                if (f) {
                  setInstaller(f);
                  setName(baseName(f));
                }
              }}
            >
              Browse...
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="heading">Monitoring is active. Run the installer to the end, including any first-run setup.</p>
          <p className={`monitor-mode ${live ? 'on' : ''}`}>
            {live
              ? 'Live tracking is on: every file and registry change made by the installer and the programs it starts is recorded as it happens.'
              : resume?.attached
                ? 'This installer was already running when monitoring began, so the before and after snapshots are compared. (Live tracking follows only installers that Purgeon starts itself.)'
              : installer
                ? 'Live tracking needs Purgeon to run as administrator, so only the before and after snapshots are compared.'
                : 'Without a chosen installer, only the before and after snapshots are compared. Choose the installer to also track it live.'}
          </p>
          {installer && <p className="muted">Installer: {installer}</p>}
          <label className="field">
            Name for this program
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Foo Editor" title="The name this recording is listed under in Monitored Programs" />
          </label>
        </>
      )}
    </Dialog>
  );
}

const baseName = (p) => (p || '').split('\\').pop().replace(/\.(exe|msi|msix|bat|cmd)$/i, '').replace(/[-_.]?(setup|installer|install|x64|x86|win64|win32)\b/gi, '').replace(/[-_]+/g, ' ').trim();

export function SystemInfoDialog({ data, onClose }) {
  return (
    <Dialog title="System Info" onClose={onClose} width={600} buttons={<button className="primary" onClick={onClose}>Close</button>}>
      {!data ? (
        <p className="footnote">Reading this PC's details…</p>
      ) : (
        <div className="sysinfo">
          {(data.sections || []).map((s) => (
            <div key={s.title} className="sysinfo-section">
              <div className="sysinfo-title">{s.title}</div>
              {s.rows.map((r, i) => (
                <div key={i} className="sysinfo-row">
                  <div className="sysinfo-main">
                    {r.head}
                    {r.tempC != null && <span className="sysinfo-temp">{r.tempC} °C</span>}
                  </div>
                  {r.sub && <div className="sysinfo-sub">{r.sub}</div>}
                </div>
              ))}
            </div>
          ))}
          <p className="footnote">Temperatures appear only where Windows reports them.</p>
        </div>
      )}
    </Dialog>
  );
}

export function AboutDialog({ onClose }) {
  return (
    <Dialog title="About Purgeon" onClose={onClose} width={560} buttons={<><button className="primary" onClick={onClose}>OK</button><button onClick={() => api.invoke('program:openUrl', 'https://github.com/SeanShaffer88/Purgeon/releases').catch(() => {})}>View Releases</button></>}>
      <p className="heading">Purgeon {__APP_VERSION__}</p>
      {window.__sweepPortable && <p className="muted">Portable mode: settings, backups and snapshots are kept in the "Purgeon Data" folder next to the program.</p>}
      <p>Uninstalls programs, then hunts down the leftover files, registry keys, startup entries and services they leave behind.</p>
      <p>It also monitors installations, compares system snapshots, cleans junk files and manages startup programs. Every change is backed up first and can be undone.</p>
      <p className="muted">An independent project, not affiliated with any other uninstaller.</p>
      <p className="muted">See <a href="https://github.com/SeanShaffer88/Purgeon/releases" target="_blank" rel="noopener noreferrer">What's New</a> for the latest release notes.</p>
    </Dialog>
  );
}

// Shown on start when a removal was cut off (a crash or power cut) partway through.
export function InterruptedDialog({ pending, onChoose }) {
  if (pending.corrupt) {
    return (
      <Dialog
        title="Interrupted Removal"
        onClose={() => onChoose('keep')}
        width={560}
        buttons={
          <button className="primary" onClick={() => onChoose('keep')}>
            Clear the Record
          </button>
        }
      >
        <p className="heading">A removal did not finish, and its record is damaged.</p>
        <p>
          Purgeon was stopped while it was writing down what the removal had done, so it cannot tell which removal it was or what had already been removed. Nothing more will be removed, and any backup the removal made is still in Tools › Backups. Clearing the record just removes the damaged note; it does not change anything else.
        </p>
      </Dialog>
    );
  }
  return (
    <Dialog
      title="Interrupted Removal"
      onClose={() => onChoose('keep')}
      width={560}
      buttons={
        <>
          <button className="primary" onClick={() => onChoose('rollback')}>
            Roll Back
          </button>
          <button onClick={() => onChoose('finish')}>Finish Removal</button>
          <button onClick={() => onChoose('keep')}>Leave As Is</button>
        </>
      }
    >
      <p className="heading">The removal “{pending.title}” did not finish.</p>
      <p>
        It was started {new Date(pending.started).toLocaleString()} and had removed {pending.done} of {pending.total} items when it stopped. Everything it removed was backed up first.
      </p>
      <ul className="choices">
        <li>
          <b>Roll Back</b> puts back what it removed (recommended).
        </li>
        <li>
          <b>Finish Removal</b> removes the remaining items, with the same checks as before.
        </li>
        <li>
          <b>Leave As Is</b> keeps things as they are; the backup stays in Tools › Backups.
        </li>
      </ul>
    </Dialog>
  );
}

// Limits for how long and how much backup data is kept. 0 means no limit.
export function BackupSettingsDialog({ settings, onSave, onClose }) {
  const [days, setDays] = useState(String(settings.backupMaxDays || 0));
  const [mb, setMb] = useState(String(settings.backupMaxMB || 0));
  const valid = /^\d{1,5}$/.test(days) && /^\d{1,7}$/.test(mb);
  return (
    <Dialog
      title="Backup Settings"
      onClose={onClose}
      width={640}
      buttons={
        <>
          <button className="primary" disabled={!valid} onClick={() => onSave({ backupMaxDays: Number(days), backupMaxMB: Number(mb) })}>
            Save
          </button>
          <button onClick={() => {
            const json = JSON.stringify(settings, null, 2);
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'purgeon-settings.json';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
          }}>Export Settings…</button>
          <button onClick={() => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json';
            input.onchange = (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              const reader = new FileReader();
              reader.onload = (ev) => {
                try {
                  const parsed = JSON.parse(ev.target.result);
                  onSave(parsed);
                } catch (err) {
                  setError?.('Invalid settings file.');
                }
              };
              reader.readAsText(file);
            };
            document.body.appendChild(input);
            input.click();
            document.body.removeChild(input);
          }}>Import Settings…</button>
          <button onClick={onClose}>Cancel</button>
        </>
      }
    >
      <p className="heading">Old backups can be removed automatically. Use 0 to keep them all.</p>
      <label className="field">
        Remove backups older than (days)
        <input inputMode="numeric" title="Backups older than this many days are deleted (each program’s newest backup is always kept). Empty means no age limit." value={days} onChange={(e) => setDays(e.target.value.trim())} />
      </label>
      <SettingHelp key="backupMaxDays" />
      <label className="field">
        Keep backups under this total size (MB)
        <input inputMode="numeric" title="When all backups together are larger than this, the oldest are deleted first (each program’s newest is always kept). Empty means no size limit." value={mb} onChange={(e) => setMb(e.target.value.trim())} />
      </label>
      <SettingHelp key="backupMaxMB" />
      <p className="footnote">
        The newest backup of each program is always kept, so the last removal of anything can still be undone. Once a backup is removed, Change History can no longer undo that change. Files in the Recycle Bin are not counted or touched.
      </p>
      <p className="footnote">
        Export saves all Purgeon settings (themes, confirmations, sync, safe mode) to a JSON file. Import restores them. Your programs and backups are not affected.
      </p>
    </Dialog>
  );
}
