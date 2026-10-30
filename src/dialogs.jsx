import { Dialog, Busy } from './core-dialog.jsx';
import { itemLabel, safeAllowed, PlanView, signatureText } from './dialog-shared.jsx';
export { Dialog, ConfirmDialog, Busy, useModalLayer } from './core-dialog.jsx';
export { PlanView, planHtml, safeAllowed, signatureText } from './dialog-shared.jsx';
import { tx } from './backend/i18n.js';
import { useMemo, useState, useEffect, useRef } from 'react';
import { SettingHelp } from './onboarding.jsx';
import { t } from './backend/i18n.js';
import { leftoverSections } from './leftover-sections.js';

const api = window.api;

const GROUPS = [
  { id: 'registry', label: 'Registry', kinds: ['key', 'value', 'createkey', 'setvalue'] },
  { id: 'files', label: 'Files and Folders', kinds: ['dir', 'file', 'junk'] },
  { id: 'services', label: 'Services', kinds: ['service'] },
  { id: 'tasks', label: 'Scheduled Tasks', kinds: ['task'] },
  { id: 'firewall', label: 'Firewall Rules', kinds: ['firewall'] },
];

export function LeftoversDialog({ title, heading, items, onClose, onRemove, onDryRun, onExportPlan, safeMode = false }) {
  const allowed = (it) => safeAllowed(it, safeMode);
  const [checked, setChecked] = useState(() => new Set(items.map((it, idx) => (it.confidence === 'high' && allowed(it) ? idx : -1)).filter((i) => i >= 0)));
  const [plan, setPlan] = useState(null);
  const [planning, setPlanning] = useState(false);
  const hidden = items.filter((it) => !allowed(it)).length;
  const [collapsed, setCollapsed] = useState(new Set());
  // Batch results carry `program`; those are grouped by program first, then by type.
  const sections = useMemo(() => leftoverSections(items, GROUPS), [items]);
  const programs = sections.map((section) => section.program);
  const byProgram = programs.length > 1 || programs[0] !== '';
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
          <span className="button-hint">{t('selectionFraction', { selected: checked.size, total: items.length })}</span>
          <button onClick={() => setChecked(new Set(items.map((_, i) => i).filter((i) => allowed(items[i]))))}>{tx("Select All")}</button>
          <button onClick={() => setChecked(new Set())}>{tx("Select None")}</button>
          {onDryRun && (
            <button disabled={!checked.size || planning} onClick={dryRun} title={tx("Check what would happen, without changing anything")}>
              {planning ? tx("Checking…") : tx("Dry Run")}
            </button>
          )}
          <button className="primary" disabled={!checked.size} onClick={() => onRemove(selected())}>{tx("Delete Selected")}</button>
          <button onClick={onClose}>{tx("Close")}</button>
        </>
      }
    >
      <p className="heading">{tx(heading)}</p>
      {safeMode && hidden > 0 && <div className="safe-note">{tx("Safe mode: ")}{hidden}{tx(" lower-confidence item")}{hidden === 1 ? tx(" is") : tx("s are")}{tx(" shown but can’t be selected. Turn it off in Tools › Safe Mode.")}</div>}
      {plan ? (
        <PlanView results={plan} onBack={() => setPlan(null)} onExport={() => onExportPlan(plan)} />
      ) : items.length === 0 ? (
        <div className="empty-box">{tx("No leftovers found. Everything was removed cleanly.")}</div>
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
                  <b>{tx(g.label)}</b> <span className="muted">({g.rows.length})</span>
                </div>
                {open &&
                  g.rows.map(({ it, idx }) => (
                    <label key={idx} className={`tree-item ${it.confidence === 'low' ? 'low' : ''} ${allowed(it) ? '' : 'locked'}`} title={`${it.evidence || 'Ownership evidence'}: ${it.reason}`}>
                      <input type="checkbox" checked={checked.has(idx)} disabled={!allowed(it)} onChange={() => toggle(idx)} />
                      <span className={`kind kind-${it.kind}`} />
                      <span className="path">{itemLabel(it)}</span>
                      {it.confidence === 'low' && <span className="tag">{tx("check")}</span>}
                      {typeof it.score === 'number' && (
                        <span className={`score ${it.confidence === 'high' ? 'hi' : 'lo'}`}>{it.evidence || (it.confidence === 'high' ? tx("Direct reference") : tx("Review required"))}</span>
                      )}
                    </label>
                  ))}
              </div>
            );
            }),
          ])}
        </div>
      )}
      <p className="footnote">{tx("Cleanup records and available registry exports are kept in Tools › Backups. File recovery requires the original Recycle Bin copies. Some actions cannot be undone.")}</p>
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
  }, []);

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
      if (v.cancelled) setError(tx("Verification cancelled — the package keeps its previous verdict."));
      else if (!v.ok) setError(tx("Verification found problems: {p0}", { p0: (v.problems.join('; ')) }));
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
      <span className="pkg-badge ok">{tx("Restorable ✓ verified")}</span>
    ) : p.verified === false ? (
      <span className="pkg-badge bad">{tx("Verification failed")}</span>
    ) : (
      <span className="pkg-badge warn">{tx("Not verified")}</span>
    );

  return (
    <Dialog title={tx("Recovery Packages")} onClose={onClose} width={880} buttons={<button className="primary" onClick={onClose}>{tx("Close")}</button>}>
      <p className="muted" style={{ marginBottom: 10 }}>{tx("Backups taken before removals. Each new package is test-restored when it is created, so “Restorable” means it was proven, not hoped.")}</p>
      {error && <div className="error-bar" style={{ marginBottom: 10 }}><span>{error}</span></div>}
      {packages === null ? (
        <p className="muted">{tx("Loading…")}</p>
      ) : packages.length === 0 ? (
        <p className="muted">{tx("No backups yet. Backups appear here when something is removed.")}</p>
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
              <button onClick={verify} disabled={!selected || !!busy} title={tx("Re-check this package: seal, stored files, trial restore, Recycle Bin contents")}>
                {busy === 'Verifying…' ? tx("Verifying…") : tx("Verify Selected")}
              </button>
              {busy === 'Verifying…' && <button onClick={() => api.invoke('backups:verifyCancel').catch(() => {})}>{tx("Cancel")}</button>}
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
                <div className="pkg-entries-head">{tx("Contents — ")}{selected.title}</div>
                {selected.entries.map((e, i) => (
                  <label key={i} className="pkg-entry">
                    <input
                      type="checkbox"
                      checked={ticked.has(i)}
                      onChange={() => setTicked((t) => { const n = new Set(t); if (n.has(i)) n.delete(i); else n.add(i); return n; })}
                    />
                    <span>{(ENTRY_LABEL[e.kind] || ((x) => x.path))(e)}{e.recycled ? tx(" (in the Recycle Bin)") : ''}</span>
                  </label>
                ))}
                <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                  <button className="primary" onClick={() => restore([...ticked].sort((a, b) => a - b))} disabled={!ticked.size || !!busy} title={tx("Restore only the ticked items")}>
                    {busy === 'Restoring…' ? tx("Restoring…") : tx("Restore Ticked Items")}
                  </button>
                  <button onClick={() => restore(selected.entries.map((_, i) => i))} disabled={!!busy} title={tx("Restore everything in this package")}>{tx("Restore Everything")}</button>
                  {busy === 'Restoring…' && <button onClick={() => api.invoke('backups:restoreCancel').catch(() => {})}>{tx("Cancel")}</button>}
                </div>
              </>
            )}
            {selected && results && (
              <>
                <div className="pkg-entries-head">{tx("Restore results")}</div>
                {results.map((r, i) => (
                  <div key={i} className="pkg-entry">
                    <span>{r.ok ? '✓' : '✗'} {(ENTRY_LABEL[r.kind] || ((x) => x.path))(r)} <span className="muted">— {tx(r.detail)}</span></span>
                  </div>
                ))}
                <div style={{ marginTop: 12 }}>
                  <button onClick={() => setResults(null)}>{tx("Back to Contents")}</button>
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
    <Dialog title={tx("Shared Components")} onClose={onClose} width={880} buttons={<button className="primary" onClick={onClose}>{tx("Close")}</button>}>
      <p className="muted" style={{ marginBottom: 10 }}>{tx("Parts used by more than one program. These are what Purgeon refuses to delete during a removal — here is exactly why, and who would be affected.")}</p>
      {items === null ? (
        <p className="muted">{tx("Loading…")}</p>
      ) : items.length === 0 ? (
        <p className="muted">{tx("No shared components were found on this PC.")}</p>
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
                <div className="pkg-entries-head">{current.kind === 'folder' ? tx("Depends on it") : current.kind === 'runtime' ? tx("Shared runtime") : tx("Shared file")}</div>
                <div className="pkg-entry"><span className="muted">{current.path}</span></div>
                <p style={{ fontSize: 13, margin: '6px 0 10px' }}>{tx(current.detail)}</p>
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
    <Dialog title={tx("Secure Erase")} onClose={onClose} width={760} buttons={<button className="primary" onClick={onClose}>{tx("Close")}</button>}>
      <p className="muted" style={{ marginBottom: 10 }}>{tx("Overwrites each file’s contents before deleting it, so the data cannot be undeleted. There is no backup and no undo — that is the point of this tool. Registry items are not offered: overwriting has no meaning there.")}</p>
      {error && <div className="error-bar" style={{ marginBottom: 10 }}><span>{error}</span></div>}
      {!results && !confirming && (
        <>
          <button className="erase-drop" onClick={() => add(false)} title={tx("Choose files to erase")}>{tx("Add files to erase…")}</button>
          <div style={{ display: 'flex', gap: 8, margin: '10px 0' }}>
            <button onClick={() => add(false)}>{tx("Add Files…")}</button>
            <button onClick={() => add(true)}>{tx("Add Folder…")}</button>
            {files.length > 0 && <button className="ghost" onClick={() => { setFiles([]); setRefused([]); }}>{tx("Clear List")}</button>}
          </div>
          {files.map((f) => (
            <div key={f.path} className="pkg-entry"><span>{f.path} <span className="muted">{f.size ? tx("{p0} MB", { p0: ((f.size / 1048576).toFixed(1)) }) : ''}</span></span></div>
          ))}
          {refused.map((r) => (
            <div key={r.path} className="pkg-entry"><span className="muted">✗ {r.path} — {r.reason}</span></div>
          ))}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 14 }}>
            <span className="muted">{tx("Overwrite:")}</span>
            <span className="seg">
              {[['zero', '1 pass · zeros'], ['random', '1 pass · random'], ['three', '3 passes']].map(([id, label]) => (
                <button key={id} className={pattern === id ? 'sel' : ''} onClick={() => setPattern(id)}>{tx(label)}</button>
              ))}
            </span>
            <span style={{ flex: 1 }} />
            <button className="primary danger" disabled={!files.length} onClick={() => setConfirming(true)} title={tx("Review the list once more, then erase")}>{tx("Erase ")}{files.length || ''}{tx(" File")}{files.length === 1 ? '' : tx("s")}…
            </button>
          </div>
          <div className="note" style={{ marginTop: 14 }}>{tx("Honest limit: on modern SSDs the drive moves data around internally, so overwriting lowers the chance of recovery but cannot promise it. For total certainty, encrypt the drive or destroy it physically.")}</div>
        </>
      )}
      {!results && confirming && (
        <>
          <p style={{ fontSize: 13, marginBottom: 8 }}>
            <strong>{tx("This cannot be undone.")}</strong> {files.length}{tx(" file")}{files.length === 1 ? '' : tx("s")} ({(totalBytes / 1048576).toFixed(1)}{tx(" MB) will be overwritten and deleted, with no backup:")}</p>
          {files.map((f) => (
            <div key={f.path} className="pkg-entry"><span>{f.path}</span></div>
          ))}
          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <button className="primary danger" onClick={run} disabled={running} title={tx("Overwrite and delete the listed files")}>
              {running ? tx("Erasing…") : tx("Confirm Erase")}
            </button>
            {running && <button onClick={() => api.invoke('erase:runCancel')} title={tx("Stop after the current file (a file mid-overwrite is left partially overwritten)")}>{tx("Cancel")}</button>}
            {!running && <button onClick={() => setConfirming(false)}>{tx("Back")}</button>}
          </div>
        </>
      )}
      {results && (
        <>
          <div className="pkg-entries-head">{tx("Erase results")}</div>
          {results.map((r, i) => (
            <div key={i} className="pkg-entry"><span>{r.ok ? '✓' : '✗'} {r.path} <span className="muted">— {tx(r.detail)}</span></span></div>
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
      else setError(out.results?.[0]?.detail || tx("The entry could not be removed."));
      load();
    } catch (e) {
      setError(e.message);
    }
  };

  const total = (games || []).reduce((a, g) => a + (g.size || 0), 0);

  return (
    <Dialog title={tx("Games")} onClose={onClose} width={760} buttons={<button className="primary" onClick={onClose}>{tx("Close")}</button>}>
      <p className="muted" style={{ marginBottom: 10 }}>{tx("Games the launchers on this PC report, with the space each one takes. Uninstalling a game stays with its launcher — that is where its files and account live. If a game's files are already gone, Purgeon can clean up the leftover entry, with a backup made first.")}</p>
      {error && <div className="error-bar" style={{ marginBottom: 10 }}><span>{error}</span></div>}
      {note && <div className="note" style={{ marginBottom: 10 }}>{tx(note)}</div>}
      {games === null ? (
        <p className="muted">{tx("Looking for games… ")}<button className="btn small" style={{ marginLeft: 8 }} onClick={() => { api.invoke('games:listCancel').catch(() => {}); setGames([]); setNote('The search was cancelled — sizes shown so far may be incomplete.'); }}>{tx("Cancel")}</button></p>
      ) : games.length === 0 ? (
        <p className="muted">{tx("No games were found. Steam, Epic and GOG libraries are checked.")}</p>
      ) : (
        <>
          {games.map((g) => (
            <div key={`${g.launcher}:${g.entryPath}:${g.name}`} className="pkg-entry">
              <span>
                {g.name} <span className="launcher-chip">{g.launcher}</span>{' '}
                <span className="muted">{g.location}</span>
              </span>
              {g.present ? (
                <span className="muted" style={{ marginLeft: 'auto', flex: 'none' }}>{g.size ? tx("{p0} GB{p1}", { p0: ((g.size / 1073741824).toFixed(1)), p1: (g.partial ? '+' : '') }) : '—'}</span>
              ) : (
                <span style={{ marginLeft: 'auto', flex: 'none', display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span className="pkg-badge warn">{tx("files gone")}</span>
                  <button onClick={() => cleanup(g)} title={tx("Remove this launcher entry — a backup is made first, so it can be restored from the Archive")}>
                    {confirming === g.entryPath ? tx("Confirm cleanup?") : tx("Clean Up Entry")}
                  </button>
                </span>
              )}
            </div>
          ))}
          <p className="muted" style={{ marginTop: 10 }}>{tx("Total: ")}{(total / 1073741824).toFixed(1)}{tx(" GB across ")}{games.filter((g) => g.present).length}{tx(" installed games.")}</p>
        </>
      )}
    </Dialog>
  );
}

// Relationship Graph (Tools › Advanced Tools): how each program connects
// to the rest of the system, joined entirely on this PC. Orphans — entries
// pointing at files that no longer exist, belonging to no installed
// program — come first.
export function GraphDialog({ onClose }) {
  const alive = useRef(true);
  const graphGeneration = useRef(0);
  const selectionGeneration = useRef(0);
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(null);
  const [deep, setDeep] = useState(null);
  const [confirming, setConfirming] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');

  const load = () => {
    const generation = ++graphGeneration.current;
    selectionGeneration.current++;
    setSelected(null);
    setDeep(null);
    setLoading(true);
    const current = () => alive.current && generation === graphGeneration.current;
    api.invoke('graph:graph').then((d) => { if (!current()) return; setData(d); setLoading(false); if (d.cancelled) setNote('The scan was cancelled — the map may be incomplete.'); }).catch((e) => { if (!current()) return; setData({ programs: [], orphans: [] }); setLoading(false); setError(e.message); });
  };
  useEffect(() => { alive.current = true; load(); return () => { alive.current = false; graphGeneration.current++; selectionGeneration.current++; }; }, []);

  const pick = (n) => {
    const generation = ++selectionGeneration.current;
    setSelected(n);
    setDeep(null);
    const current = () => alive.current && generation === selectionGeneration.current;
    api.invoke('graph:program', n).then((value) => { if (current()) setDeep(value); }).catch(() => { if (current()) setDeep({ dependents: [], unknown: 0, note: '', sharedFiles: 0 }); });
  };

  const removeOrphan = async (o) => {
    const id = `${o.kind}:${o.label}`;
    if (confirming !== id) { setConfirming(id); return; }
    setConfirming('');
    setError('');
    try {
      const out = await api.invoke('graph:removeOrphan', o);
      if (!alive.current) return;
      if (out.results?.[0]?.ok) setNote(`${o.label} was removed. A backup was made first — restore it from the Archive if needed.`);
      else setError(out.results?.[0]?.detail || tx("The entry could not be removed."));
      load();
    } catch (e) {
      if (alive.current) setError(e.message);
    }
  };

  const q = query.trim().toLowerCase();
  const programs = (data?.programs || []).filter((n) => !q || n.name.toLowerCase().includes(q));
  const orphans = (data?.orphans || []).filter((o) => !q || o.label.toLowerCase().includes(q));

  return (
    <Dialog title={tx("Relationship Graph")} onClose={onClose} width={880} buttons={<button className="primary" onClick={onClose}>{tx("Close")}</button>}>
      <p className="muted" style={{ marginBottom: 10 }}>{tx("How each program connects to the rest of the system — worked out entirely on this PC; nothing leaves the machine.")}</p>
      {error && <div className="error-bar" style={{ marginBottom: 10 }}><span>{error}</span></div>}
      {note && <div className="note" style={{ marginBottom: 10 }}>{tx(note)}</div>}
      <input className="pkg-search" type="search" placeholder={tx("Search programs…")} value={query} onChange={(e) => setQuery(e.target.value)} />
      {data === null ? (
        <p className="muted">{tx("Building the graph… ")}<button className="btn small" style={{ marginLeft: 8 }} onClick={() => api.invoke('graph:graphCancel').catch(() => {})}>{tx("Cancel")}</button></p>
      ) : (
        <div className="recovery-cols">
          <div className="pkg-list">
            {orphans.length > 0 && <div className="pkg-entries-head" style={{ padding: '2px 4px 6px' }}>{tx("Connected to nothing")}</div>}
            {orphans.map((o) => (
              <div key={`orphan:${o.kind}:${o.label}`} className="pkg-row" style={{ cursor: 'default' }}>
                <span className="pkg-name">{o.label} <span className="muted">· {o.kind}</span></span>
                <span className="pkg-badge bad">{tx("missing file")}</span>
              </div>
            ))}
            <div className="pkg-entries-head" style={{ padding: '8px 4px 6px' }}>{tx("Programs")}</div>
            {programs.map((n) => (
              <button key={n.name} className={`pkg-row ${selected?.name === n.name ? 'sel' : ''}`} onClick={() => pick(n)}>
                <span className="pkg-name">{n.name}</span>
                <span className="muted" style={{ marginLeft: 'auto', flex: 'none' }}>{n.links.length}{tx(" connected")}</span>
              </button>
            ))}
            {programs.length === 0 && <p className="muted" style={{ padding: 4 }}>{tx("No programs match.")}</p>}
          </div>
          <div className="pkg-entries">
            {selected ? (
              <>
                <div className="pkg-entries-head">{selected.name}</div>
                {selected.links.map((l, i) => (
                  <div key={i} className="pkg-entry"><span>{l.kind}: {l.label} <span className="muted">{l.target}</span></span></div>
                ))}
                {selected.links.length === 0 && <p className="muted" style={{ fontSize: 13 }}>{tx("No services, tasks or startup entries run this program's files.")}</p>}
                {deep === null ? (
                  <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>{tx("Checking what depends on it…")}</p>
                ) : (
                  <>
                    {deep.dependents.length > 0 && <p style={{ fontSize: 13, marginTop: 8 }}>{tx("Depended on by: ")}{deep.dependents.join(', ')}</p>}
                    {deep.unknown > 0 && <p style={{ fontSize: 13, marginTop: 8 }}>{deep.unknown}{tx(" other installation")}{deep.unknown === 1 ? '' : tx("s")}{tx(" registered a need for it.")}</p>}
                    {deep.sharedFiles > 0 && <p style={{ fontSize: 13, marginTop: 8 }}>{tx("Its folder holds ")}{deep.sharedFiles}{tx(" shared file")}{deep.sharedFiles === 1 ? '' : tx("s")}{tx(" other programs use.")}</p>}
                    {deep.note && <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>{tx(deep.note)}</p>}
                  </>
                )}
              </>
            ) : orphans.length > 0 ? (
              <>
                <div className="pkg-entries-head">{tx("Orphaned entries")}</div>
                {orphans.map((o) => (
                  <div key={`od:${o.kind}:${o.label}`} className="pkg-entry">
                    <span>{o.label} <span className="muted">· {o.kind}{tx(" · points at ")}{o.target}{tx(", which is no longer there")}</span></span>
                    {(o.type === 'service' || o.type === 'task') && (
                      <button style={{ marginLeft: 'auto', flex: 'none' }} onClick={() => removeOrphan(o)} title={tx("Remove this entry — a backup is made first, so it can be restored from the Archive")}>
                        {confirming === `${o.kind}:${o.label}` ? tx("Confirm removal?") : tx("Remove…")}
                      </button>
                    )}
                  </div>
                ))}
                <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>{tx("Startup entries are listed but not removed here — a startup entry is one value inside a shared registry key, so turn those off in Startup & Services instead. Services and tasks are removed only through the standard backed-up removal.")}</p>
              </>
            ) : (
              <p className="muted">{tx("Pick a program to see its connections.")}</p>
            )}
          </div>
        </div>
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
          {onUndo && results.some((r) => r.ok) && <button onClick={onUndo}>{tx("Undo")}</button>}
          <button className="primary" onClick={onClose}>{tx("OK")}</button>
        </>
      }
    >
      <p className="heading">
        {failed.length ? tx("{p0} of {p1} items done, {p2} failed.", { p0: (results.length - failed.length), p1: (results.length), p2: (failed.length) }) : tx("All {p0} items done.", { p0: (results.length) })}
      </p>
      <div className="tree">
        {/* Problems first; very long reports (a junk cleanup) show the first 500 rows. */}
        {[...failed, ...results.filter((r) => r.ok)].slice(0, 500).map((r, i) => (
          <div key={i} className={`result ${r.ok ? 'ok' : 'fail'}`}>
            <span className="mark">{r.ok ? '✓' : '✗'}</span>
            <span className="path">{itemLabel(r)}</span>
            <span className="muted">{tx(r.detail)}</span>
          </div>
        ))}
        {results.length > 500 && <div className="muted result">{tx("…and ")}{(results.length - 500).toLocaleString()}{tx(" more")}</div>}
      </div>
      {note && <p className="footnote">{tx(note)}</p>}
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
    <Dialog title={tx("Properties – {p0}", { p0: (program.name) })} onClose={onClose} width={600} buttons={<button className="primary" onClick={onClose}>{tx("OK")}</button>}>
      <table className="props">
        <tbody>
          {rows
            .filter(([, v]) => v !== undefined && v !== null && v !== '')
            .map(([k, v]) => (
              <tr key={k}>
                <th>{k}</th>
                <td>
                  <input readOnly title={tx("Click to select the whole value, then Ctrl+C to copy it")} value={String(v)} onFocus={(e) => e.target.select()} />
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

  if (step === 'before') return <Busy message={tx("Taking a snapshot of files and registry before installation…")} />;
  if (step === 'after') return <Busy message={tx("Taking the second snapshot and comparing changes…")} />;

  return (
    <Dialog
      title={tx("Monitor an Installation")}
      onClose={cancel}
      width={560}
      buttons={
        step === 'pick' ? (
          <>
            <button className="primary" onClick={begin}>
              {installer ? tx("Start Monitoring") : tx("Start (I will run the installer)")}
            </button>
            <button onClick={cancel}>{tx("Cancel")}</button>
          </>
        ) : (
          <>
            <button className="primary" disabled={!name.trim()} onClick={finish}>{tx("Installation Finished")}</button>
            <button onClick={cancel}>{tx("Cancel Monitoring")}</button>
          </>
        )
      }
    >
      {error && <div className="error-box">{error}</div>}
      {step === 'pick' ? (
        <>
          <p className="heading">{tx("Purgeon records file and registry changes within the snapshot scope. Live tracing can attribute changes to an installer. Unrelated changes remain unchecked; changed file contents are not stored for complete rollback.")}</p>
          <ol className="steps">
            <li>{tx("Close other programs so their changes aren't recorded.")}</li>
            <li>{tx("Choose the installer. Purgeon takes a snapshot and then starts it.")}</li>
            <li>{tx("When setup is done, come back and click ")}<b>{tx("Installation Finished")}</b>.</li>
          </ol>
          <div className="field-row">
            <input readOnly value={installer} placeholder={tx("No installer chosen")} title={tx("The installer to run while monitoring. Use Browse to choose one, or leave it empty and run the installer yourself.")} />
            <button
              onClick={async () => {
                const f = await api.invoke('monitor:pickInstaller');
                if (f) {
                  setInstaller(f);
                  setName(baseName(f));
                }
              }}
            >{tx("Browse...")}</button>
          </div>
        </>
      ) : (
        <>
          <p className="heading">{tx("Monitoring is active. Run the installer to the end, including any first-run setup.")}</p>
          <p className={`monitor-mode ${live ? 'on' : ''}`}>
            {live
              ? tx("Live tracking is on: every file and registry change made by the installer and the programs it starts is recorded as it happens.")
              : resume?.attached
                ? tx("This installer was already running when monitoring began, so the before and after snapshots are compared. (Live tracking follows only installers that Purgeon starts itself.)")
              : installer
                ? tx("Live tracking needs Purgeon to run as administrator, so only the before and after snapshots are compared.")
                : tx("Without a chosen installer, only the before and after snapshots are compared. Choose the installer to also track it live.")}
          </p>
          {installer && <p className="muted">{tx("Installer: ")}{installer}</p>}
          <label className="field">{tx("Name for this program")}<input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={tx("e.g. Foo Editor")} title={tx("The name this recording is listed under in Monitored Programs")} />
          </label>
        </>
      )}
    </Dialog>
  );
}

const baseName = (p) => (p || '').split('\\').pop().replace(/\.(exe|msi|msix|bat|cmd)$/i, '').replace(/[-_.]?(setup|installer|install|x64|x86|win64|win32)\b/gi, '').replace(/[-_]+/g, ' ').trim();

export function SystemInfoDialog({ data, onClose }) {
  return (
    <Dialog title={tx("System Info")} onClose={onClose} width={600} buttons={<button className="primary" onClick={onClose}>{tx("Close")}</button>}>
      {!data ? (
        <p className="footnote">{tx("Reading this PC's details…")}</p>
      ) : (
        <div className="sysinfo">
          {(data.sections || []).map((s) => (
            <div key={s.title} className="sysinfo-section">
              <div className="sysinfo-title">{s.title}</div>
              {s.rows.map((r, i) => (
                <div key={i} className="sysinfo-row">
                  <div className="sysinfo-main">
                    {r.head}
                    {r.tempC != null && <span className="sysinfo-temp">{r.tempC}{tx(" °C")}</span>}
                  </div>
                  {r.sub && <div className="sysinfo-sub">{r.sub}</div>}
                </div>
              ))}
            </div>
          ))}
          <p className="footnote">{tx("Temperatures appear only where Windows reports them.")}</p>
        </div>
      )}
    </Dialog>
  );
}

export function AboutDialog({ onClose }) {
  return (
    <Dialog title={tx("About Purgeon")} onClose={onClose} width={560} buttons={<><button className="primary" onClick={onClose}>{tx("OK")}</button><button onClick={() => api.invoke('program:openUrl', 'https://github.com/SeanShaffer88/Purgeon/releases').catch(() => {})}>{tx("View Releases")}</button></>}>
      <p className="heading">{tx("Purgeon ")}{__APP_VERSION__}</p>
      {window.__sweepPortable && <p className="muted">{tx("Portable mode: settings, backups and snapshots are kept in the \"Purgeon Data\" folder next to the program.")}</p>}
      <p>{tx("Uninstalls programs, then hunts down the leftover files, registry keys, startup entries and services they leave behind.")}</p>
      <p>{tx("It also monitors installations, compares system snapshots, cleans junk files and manages startup programs. Recovery options vary by action; review the plan and available backups before making changes.")}</p>
      <p className="muted">{tx("An independent project, not affiliated with any other uninstaller.")}</p>
      <p className="muted">{tx("See ")}<a href="https://github.com/SeanShaffer88/Purgeon/releases" target="_blank" rel="noopener noreferrer">{tx("What's New")}</a>{tx(" for the latest release notes.")}</p>
    </Dialog>
  );
}

// Shown on start when a removal was cut off (a crash or power cut) partway through.
export function InterruptedDialog({ pending, onChoose }) {
  if (pending.uncertain || pending.reviewRequired || pending.corrupt) return (
    <Dialog title={t('recoveryReviewTitle')} onClose={() => onChoose('dismiss')} width={580} buttons={<button className="primary" data-safe-default onClick={() => onChoose('dismiss')}>{t('close')}</button>}>
      <p>{t('recoveryReviewBody')}</p>
      <div className="recovery-review">
        <p><strong>{t('name')}:</strong> {pending.title}</p>
        <p><strong>{t('recoveryOperation')}:</strong> {pending.uncertain?.kind || tx('Review Required')}</p>
        <p className="recovery-path"><strong>{t('recoveryTarget')}:</strong> {pending.uncertain?.path || pending.detail || tx('The removal record could not be read safely.')}</p>
        <p className="recovery-path"><strong>{t('backup')}:</strong> {pending.id}</p>
      </div>
      <p>{t('recoveryRetained')}</p>
    </Dialog>
  );
  return (
    <Dialog
      title={tx("Interrupted Removal")}
      onClose={() => onChoose('dismiss')}
      width={560}
      buttons={
        <>
          <button className="primary" onClick={() => onChoose('rollback')}>{tx("Roll Back")}</button>
          <button disabled title={tx("Run a fresh scan and preview before removing more items.")}>{tx("Finish Removal")}</button>
          <button onClick={() => onChoose('keep')}>{tx("Leave As Is")}</button>
        </>
      }
    >
      <p className="heading">{tx("The removal “")}{pending.title}{tx("” did not finish.")}</p>
      <p>{tx("It was started ")}{new Date(pending.started).toLocaleString()}{tx(" and had removed ")}{pending.done}{tx(" of ")}{pending.total}{tx(" items when it stopped. Everything it removed was backed up first.")}</p>
      <ul className="choices">
        <li>
          <b>{tx("Roll Back")}</b>{tx(" puts back what it removed (recommended).")}</li>
        <li>
          <b>{tx("Finish Removal")}</b>{tx(" is unavailable because the old scan cannot prove the remaining items are unchanged. Run a fresh scan and preview before removing more items.")}</li>
        <li>
          <b>{tx("Leave As Is")}</b>{tx(" keeps things as they are; the backup stays in Tools › Backups.")}</li>
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
      title={tx("Backup Settings")}
      onClose={onClose}
      width={640}
      buttons={
        <>
          <button className="primary" disabled={!valid} onClick={() => onSave({ backupMaxDays: Number(days), backupMaxMB: Number(mb) })}>{tx("Save")}</button>
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
          }}>{tx("Export Settings…")}</button>
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
                  api.invoke('dialog:confirm', { message: tx("Invalid settings file."), detail: err.message }).catch(() => {});
                }
              };
              reader.readAsText(file);
            };
            document.body.appendChild(input);
            input.click();
            document.body.removeChild(input);
          }}>{tx("Import Settings…")}</button>
          <button onClick={onClose}>{tx("Cancel")}</button>
        </>
      }
    >
      <p className="heading">{tx("Old backups can be removed automatically. Use 0 to keep them all.")}</p>
      <label className="field">{tx("Remove backups older than (days)")}<input inputMode="numeric" title={tx("Backups older than this many days are deleted (each program’s newest backup is always kept). Empty means no age limit.")} value={days} onChange={(e) => setDays(e.target.value.trim())} />
      </label>
      <SettingHelp key="backupMaxDays" />
      <label className="field">{tx("Keep backups under this total size (MB)")}<input inputMode="numeric" title={tx("When all backups together are larger than this, the oldest are deleted first (each program’s newest is always kept). Empty means no size limit.")} value={mb} onChange={(e) => setMb(e.target.value.trim())} />
      </label>
      <SettingHelp key="backupMaxMB" />
      <p className="footnote">{tx("The newest backup of each program is always kept, so the last removal of anything can still be undone. Once a backup is removed, Change History can no longer undo that change. Files in the Recycle Bin are not counted or touched.")}</p>
      <p className="footnote">{tx("Export saves all Purgeon settings (themes, confirmations, sync, safe mode) to a JSON file. Import restores them. Your programs and backups are not affected.")}</p>
    </Dialog>
  );
}

// Power Options (Tools › System Tools): the power plan and its timings,
// changed through powercfg — the same switches Settings uses. Every change
// is recorded in Change History with an undo.
export function PowerDialog({ onClose }) {
  const [state, setState] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => api.invoke('power:state').then(setState).catch((e) => { setState({ plans: [] }); setErr(e.message); });
  useEffect(() => { load(); }, []);

  const run = async (fn) => {
    setBusy(true); setErr('');
    try { await fn(); await load(); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  const MINUTES = [0, 1, 2, 3, 5, 10, 15, 20, 25, 30, 45, 60, 120, 180, 240, 300];
  const minuteOptions = (current) => {
    const list = current !== null && current !== undefined && !MINUTES.includes(current) ? [...MINUTES, current].sort((a, b) => a - b) : MINUTES;
    return list.map((m) => <option key={m} value={m}>{m === 0 ? tx("Never") : m < 60 ? tx("{p0} minutes", { p0: (m) }) : tx("{p0} hour{p1}", { p0: (m / 60), p1: (m === 60 ? '' : 's') })}</option>);
  };
  const timeoutRow = (label, kind, tip) => (
    <div className="power-row">
      <span className="power-label">{tx(label)}</span>
      <label className="power-cell">{tx("On battery")}<select disabled={busy || !state} title={tip} value={state?.[kind]?.dc ?? ''} onChange={(e) => run(() => api.invoke('power:setTimeout', { kind, acMin: state[kind].ac, dcMin: Number(e.target.value), previous: state[kind] }))}>{minuteOptions(state?.[kind]?.dc)}</select>
      </label>
      <label className="power-cell">{tx("Plugged in")}<select disabled={busy || !state} title={tip} value={state?.[kind]?.ac ?? ''} onChange={(e) => run(() => api.invoke('power:setTimeout', { kind, acMin: Number(e.target.value), dcMin: state[kind].dc, previous: state[kind] }))}>{minuteOptions(state?.[kind]?.ac)}</select>
      </label>
    </div>
  );

  return (
    <Dialog title={tx("Power Options")} onClose={onClose} width={720} buttons={<button className="primary" onClick={onClose}>{tx("Close")}</button>}>
      <p className="muted" style={{ marginBottom: 10 }}>{tx("How this PC uses power. Every change is recorded in Change History and can be undone there.")}</p>
      {err && <p className="error-text" style={{ marginBottom: 10 }}>{err}</p>}
      {state === null ? <p className="muted">{tx("Reading the power settings…")}</p> : (
        <>
          <div className="pkg-entries-head">{tx("Power plan")}</div>
          <div style={{ marginBottom: 12 }}>
            {state.plans.map((p) => (
              <button key={p.guid} className={`pkg-row ${p.active ? 'sel' : ''}`} disabled={busy || p.active} title={p.active ? tx("This is the plan in use") : tx("Switch to the {p0} plan", { p0: (p.name) })} onClick={() => run(() => api.invoke('power:setPlan', { guid: p.guid, name: p.name }))}>
                <span className="pkg-name">{p.name}</span>
                {p.active && <span className="pkg-badge ok">{tx("Active")}</span>}
              </button>
            ))}
            {state.plans.length === 0 && <p className="muted">{tx("No power plans were found.")}</p>}
          </div>
          {timeoutRow('Turn off the screen', 'screen', 'How long the PC waits, doing nothing, before the screen turns off')}
          {timeoutRow('Sleep', 'sleep', 'How long the PC waits, doing nothing, before it sleeps')}
          {timeoutRow('Hibernate', 'hibernate', 'How long the PC waits, doing nothing, before it hibernates (a deeper off that saves everything to disk)')}
          <div className="power-row">
            <span className="power-label">{tx("Battery saver turns on at")}</span>
            <label className="power-cell">{tx("Battery level")}<select disabled={busy} title={tx("Battery saver limits background work to stretch the battery once it drains to this level")} value={state.batterySaverPct ?? ''} onChange={(e) => run(() => api.invoke('power:setBatterySaver', { pct: Number(e.target.value), previous: state.batterySaverPct }))}>
                {[0, 10, 20, 30, 40, 50, 100].map((p) => <option key={p} value={p}>{p === 0 ? tx("Never") : p === 100 ? tx("Always") : `${p}%`}</option>)}
              </select>
            </label>
          </div>
          <div className="power-row">
            <span className="power-label">{tx("Timed wake-ups")}</span>
            <label className="power-cell power-check">
              <input type="checkbox" disabled={busy} checked={!!state.wakeTimers} title={tx("Let scheduled work (updates, backups) bring the PC out of sleep at a set time")} onChange={(e) => run(() => api.invoke('power:setWakeTimers', { on: e.target.checked, previous: state.wakeTimers }))} />{tx("Let scheduled work wake the PC")}</label>
          </div>
          <div className="power-row">
            <span className="power-label">{tx("USB devices")}</span>
            <label className="power-cell power-check">
              <input type="checkbox" disabled={busy} checked={!!state.usbSuspend} title={tx("Windows may power down USB devices that are sitting idle, to save power")} onChange={(e) => run(() => api.invoke('power:setUsbSuspend', { on: e.target.checked, previous: state.usbSuspend }))} />{tx("Power down idle USB devices")}</label>
          </div>
          <p className="muted" style={{ marginTop: 10 }}>{tx("On a desktop PC the battery settings are kept but have no effect until a battery exists. Plan changes apply straight away.")}</p>
        </>
      )}
    </Dialog>
  );
}

// System Restore (Tools › System Tools): per-drive restore storage and
// protection, the restore points themselves, and a hand-off to Windows'
// own restore wizard for the roll-back itself. Windows exposes no
// per-drive "protection on" reading, so drives are described by their
// storage — the window never claims more than that.
export function RestoreDialog({ onClose }) {
  const [state, setState] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmOff, setConfirmOff] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);

  const load = () => api.invoke('restore:state').then(setState).catch((e) => { setState({ drives: [], points: [] }); setErr(e.message); });
  useEffect(() => { load(); }, []);

  const run = async (fn) => {
    setBusy(true); setErr('');
    try { await fn(); await load(); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
  const PCTS = [1, 2, 3, 5, 10, 15, 20, 30, 50, 100];

  return (
    <Dialog title={tx("System Restore")} onClose={onClose} width={760} buttons={<button className="primary" onClick={onClose}>{tx("Close")}</button>}>
      <p className="muted" style={{ marginBottom: 10 }}>{tx("Restore points let Windows roll back to how things were. The roll-back itself runs in Windows' own System Restore window — this one manages the storage, the protection and the points.")}</p>
      {err && <p className="error-text" style={{ marginBottom: 10 }}>{err}</p>}
      {state === null ? <p className="muted">{tx("Reading restore settings…")}</p> : (
        <>
          <div className="pkg-entries-head">{tx("Drives")}</div>
          <div style={{ marginBottom: 12 }}>
            {state.drives.map((d) => (
              <div key={d.drive} className="pkg-row" style={{ cursor: 'default' }}>
                <span className="pkg-name">{d.drive}</span>
                <span className="muted">{d.hasStorage ? tx("Storage: {p0} used of {p1}", { p0: (d.used || '0'), p1: (d.unbounded ? 'no limit' : d.maxText) }) : tx("No restore storage set up")}</span>
                {d.hasStorage && (
                  <select disabled={busy} title={tx("The most space restore points may use on this drive. When they need more, the oldest are deleted first.")} value={d.unbounded ? 'unbounded' : (d.maxPct ?? '')}
                    onChange={(e) => run(() => api.invoke('restore:setMax', { drive: d.drive, pct: e.target.value === 'unbounded' ? null : Number(e.target.value), unbounded: e.target.value === 'unbounded', previous: { pct: d.maxPct, unbounded: d.unbounded } }))}>
                    {PCTS.map((p) => <option key={p} value={p}>{p}{tx("% of the drive")}</option>)}
                    <option value="unbounded">{tx("No limit")}</option>
                  </select>
                )}
                <button disabled={busy} title={d.hasStorage ? tx("Turn restore protection off for this drive (deletes its restore points)") : tx("Turn restore protection on for this drive")} onClick={() => (d.hasStorage ? setConfirmOff(d) : run(() => api.invoke('restore:setProtection', { drive: d.drive, on: true })))}>
                  {d.hasStorage ? tx("Turn off") : tx("Turn on")}
                </button>
              </div>
            ))}
            {state.drives.length === 0 && <p className="muted">{tx("No fixed drives were found.")}</p>}
          </div>
          <div className="pkg-entries-head" style={{ display: 'flex', alignItems: 'center' }}>{tx("Restore points")}<button style={{ marginLeft: 'auto' }} disabled={busy} title={tx("Create a restore point right now")} onClick={() => run(() => api.invoke('restore:createPoint', { description: `Created from Purgeon (${new Date().toLocaleString()})` }))}>{tx("Create one now")}</button>
          </div>
          <div style={{ marginBottom: 12 }}>
            {state.points.map((p) => (
              <div key={p.sequence} className="pkg-row" style={{ cursor: 'default' }}>
                <span className="pkg-name">{p.description}</span>
                <span className="muted">{fmtDate(p.createdISO)}</span>
                <button disabled={busy || !p.sequence || !p.created} title={tx("Delete this restore point (it cannot be brought back)")} onClick={() => setConfirmDelete(p)}>{tx("Delete")}</button>
              </div>
            ))}
            {state.points.length === 0 && <p className="muted">{tx("No restore points yet.")}</p>}
          </div>
          <p className="muted">{tx("To roll Windows back to one of these points, use Windows' own wizard:")}<button style={{ marginLeft: 8 }} disabled={busy} title={tx("Open Windows' System Restore window")} onClick={() => run(() => api.invoke('restore:openUi'))}>{tx("Open System Restore…")}</button>
          </p>
        </>
      )}
      {confirmOff && (
        <Dialog title={tx("Turn off protection for {p0}?", { p0: (confirmOff.drive) })} onClose={() => setConfirmOff(null)} width={520} buttons={<>
          <button onClick={() => setConfirmOff(null)}>{tx("Keep it on")}</button>
          <button className="danger" onClick={() => { const d = confirmOff; setConfirmOff(null); run(() => api.invoke('restore:setProtection', { drive: d.drive, on: false })); }}>{tx("Turn off and delete its points")}</button>
        </>}>
          <p>{tx("Turning protection off deletes every restore point on ")}{confirmOff.drive}{tx(". Windows offers no undo for that, and neither can Purgeon.")}</p>
        </Dialog>
      )}
      {confirmDelete && (
        <Dialog title={tx("Delete this restore point?")} onClose={() => setConfirmDelete(null)} width={520} buttons={<>
          <button onClick={() => setConfirmDelete(null)}>{tx("Keep it")}</button>
          <button className="danger" onClick={() => { const p = confirmDelete; setConfirmDelete(null); run(() => api.invoke('restore:removePoint', { sequence: p.sequence, created: p.created, description: p.description })); }}>{tx("Delete it")}</button>
        </>}>
          <p>“{confirmDelete.description}” ({fmtDate(confirmDelete.createdISO)}{tx(") will be deleted. A deleted restore point cannot be brought back.")}</p>
        </Dialog>
      )}
    </Dialog>
  );
}

// Boot Options (Tools › System Tools): what the next start does. Safe Mode
// is a start-up troubleshooting mode; the window is deliberately plain
// about two things — reading these settings needs administrator rights,
// and if Windows will not start, the recovery route is holding Shift while
// choosing Restart. Changes ask for a second confirmation because they
// take effect away from the desk, at the next start.
export function BootDialog({ onClose }) {
  const [state, setState] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [withPoint, setWithPoint] = useState(true);
  const [pending, setPending] = useState(null);

  const load = () => api.invoke('boot:state').then(setState).catch((e) => { setState({ entries: [], timeout: null, safeboot: 'none' }); setErr(e.message); });
  useEffect(() => { load(); }, []);

  const run = async (fn) => {
    setBusy(true); setErr('');
    try { await fn(); await load(); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  const MODES = [
    { id: 'none', label: 'Normal start', detail: 'Windows starts the usual way.' },
    { id: 'minimal', label: 'Safe Mode', detail: 'The next start loads only the basics — for troubleshooting a Windows that misbehaves.' },
    { id: 'network', label: 'Safe Mode with networking', detail: 'Safe Mode, plus the network — for downloading drivers or updates while troubleshooting.' },
  ];
  const timeouts = [0, 5, 10, 15, 30, 60];

  return (
    <Dialog title={tx("Boot Options")} onClose={onClose} width={700} buttons={<button className="primary" onClick={onClose}>{tx("Close")}</button>}>
      <p className="muted" style={{ marginBottom: 10 }}>{tx("Safe Mode persists across restarts until you choose Normal start here or clear the correct boot loader's safeboot setting from Windows Recovery. Nothing here restarts the PC. If you only need a one-time Safe Mode start, use Shift+Restart and Windows Startup Settings instead.")}</p>
      {err && <p className="error-text" style={{ marginBottom: 10 }}>{err}</p>}
      {state === null ? <p className="muted">{tx("Reading the boot settings…")}</p> : (
        <>
          <div className="pkg-entries-head">{tx("Next start")}</div>
          <div style={{ marginBottom: 10 }}>
            {MODES.map((m) => (
              <button key={m.id} className={`pkg-row ${state.safeboot === m.id ? 'sel' : ''}`} disabled={busy || state.safeboot === m.id} title={m.detail} onClick={() => setPending(m)}>
                <span className="pkg-name">{tx(m.label)}</span>
                {state.safeboot === m.id && <span className="pkg-badge ok">{tx("Set")}</span>}
              </button>
            ))}
            {state.safeboot === 'other' && <p className="muted">{tx("Windows is set to a specialist start mode Purgeon does not change. Choosing Normal start above clears it.")}</p>}
          </div>
          <label className="power-cell power-check" style={{ marginBottom: 12 }}>
            <input type="checkbox" checked={withPoint} disabled={busy} onChange={(e) => setWithPoint(e.target.checked)} title={tx("Make a restore point before changing the start mode, so the change sits behind a safety net")} />{tx("Create a restore point first (recommended)")}</label>
          <div className="power-row">
            <span className="power-label">{tx("Boot menu waits")}</span>
            <label className="power-cell">{tx("Seconds")}<select disabled={busy || state.timeout === null} title={tx("How long the list of Windows versions waits at start before the default one loads")} value={state.timeout ?? ''} onChange={(e) => run(() => api.invoke('boot:setTimeout', { seconds: Number(e.target.value), previous: state.timeout }))}>
                {timeouts.map((s) => <option key={s} value={s}>{s === 0 ? tx("0 (no wait)") : tx("{p0} seconds", { p0: (s) })}</option>)}
                {state.timeout !== null && !timeouts.includes(state.timeout) && <option value={state.timeout}>{state.timeout}{tx(" seconds")}</option>}
              </select>
            </label>
          </div>
          <div className="pkg-entries-head" style={{ marginTop: 12 }}>{tx("Windows versions on this PC (read-only)")}</div>
          <div style={{ marginBottom: 10 }}>
            {state.entries.map((e) => (
              <div key={e.id} className="pkg-row" style={{ cursor: 'default' }}>
                <span className="pkg-name">{e.name}</span>
                {e.isDefault && <span className="pkg-badge ok">{tx("Default")}</span>}
              </div>
            ))}
            {state.entries.length === 0 && <p className="muted">{tx("No boot entries could be read.")}</p>}
          </div>
          <p className="muted">{tx("If Windows will not start at all: hold Shift while choosing Restart (from the sign-in screen if needed) and Windows shows its recovery tools, including Startup Settings, where Safe Mode can be picked directly.")}</p>
        </>
      )}
      {pending && (
        <Dialog title={tx("Change persistent startup mode to {p0}?", { p0: (pending.label) })} onClose={() => setPending(null)} width={520} buttons={<>
          <button onClick={() => setPending(null)}>{tx("Not yet")}</button>
          <button className="primary" onClick={() => { const m = pending; setPending(null); run(() => api.invoke('boot:setSafeBoot', { mode: m.id, previous: state.safeboot, withRestorePoint: withPoint })); }}>{tx("Set it")}</button>
        </>}>
          <p>{tx(pending.detail)}</p>
          <p className="muted">{tx("It takes effect when the PC next starts. You can change your mind here any time before then")}{withPoint ? tx(", and a restore point is made first") : ''}.</p>
        </Dialog>
      )}
    </Dialog>
  );
}

// Event Logs (Tools › System Tools): every Windows event log with its
// size and record count. Saving a copy works for all of them; clearing
// always saves a copy first and keeps it; the Security log can be viewed
// and saved but never cleared or turned off (the backend refuses too).
export function LogsDialog({ onClose }) {
  const [items, setItems] = useState(null);
  const [selected, setSelected] = useState(0);
  const [filter, setFilter] = useState('');
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(null);

  const load = () => api.invoke('logs:channels').then((rows) => { setItems(rows); }).catch((e) => { setItems([]); setErr(e.message); });
  useEffect(() => { load(); }, []);

  const run = async (fn, after) => {
    setBusy(true); setErr(''); setNote('');
    try { const r = await fn(); if (after) after(r); await load(); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  const shown = (items || []).filter((c) => !filter || c.name.toLowerCase().includes(filter.toLowerCase()));
  const current = shown.length ? shown[Math.min(selected, shown.length - 1)] : null;
  const fmtSize = (b) => b === null ? tx("Unknown") : (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : b >= 1024 ? `${(b / 1024).toFixed(0)} KB` : `${b} B`);

  return (
    <Dialog title={tx("Event Logs")} onClose={onClose} width={880} buttons={<button className="primary" onClick={onClose}>{tx("Close")}</button>}>
      <p className="muted" style={{ marginBottom: 10 }}>{tx("Windows writes everything that happens into these logs. Clearing one always saves a copy into Purgeon's log-backups folder first, and the copy is kept.")}</p>
      {err && <p className="error-text" style={{ marginBottom: 10 }}>{err}</p>}
      {note && <p className="muted" style={{ marginBottom: 10 }}>{tx(note)}</p>}
      <input className="search-input" style={{ marginBottom: 10, width: '100%' }} placeholder={tx("Search logs…")} title={tx("Type part of a log's name to filter the list")} value={filter} onChange={(e) => { setFilter(e.target.value); setSelected(0); }} />
      {items === null ? <p className="muted">{tx("Reading the logs…")}</p> : shown.length === 0 ? <p className="muted">{tx("No logs match.")}</p> : (
        <div className="recovery-cols">
          <div className="pkg-list">
            {shown.map((c, i) => (
              <button key={c.name} className={`pkg-row ${current && c.name === current.name ? 'sel' : ''}`} onClick={() => setSelected(i)}>
                <span className="pkg-name">{c.name}</span>
                {c.guarded ? <span className="pkg-badge warn">{tx("Protected")}</span> : c.enabled === null ? <span className="pkg-badge warn">{tx("Unknown")}</span> : !c.enabled ? <span className="pkg-badge warn">{tx("Off")}</span> : null}
              </button>
            ))}
          </div>
          <div className="pkg-entries">
            {current && (
              <>
                <div className="pkg-entries-head">{current.name}</div>
                <div className="pkg-entry"><span className="muted">{tx("Records")}</span><span style={{ marginLeft: 'auto' }}>{current.records === null ? tx("Unknown") : current.records.toLocaleString()}</span></div>
                <div className="pkg-entry"><span className="muted">{tx("Size on disk")}</span><span style={{ marginLeft: 'auto' }}>{fmtSize(current.sizeBytes)}</span></div>
                <div className="pkg-entry"><span className="muted">{tx("Recording")}</span><span style={{ marginLeft: 'auto' }}>{current.enabled === null ? tx("Unknown") : current.enabled ? tx("On") : tx("Off")}</span></div>
                {(current.metadataError || current.configError) && <p className="error-text">{[current.metadataError, current.configError].filter(Boolean).join("; ")}</p>}
                {current.guarded && <p style={{ fontSize: 13, margin: '8px 0' }}>{tx("The Security log is the record Windows keeps of sign-ins and security events. Purgeon can save a copy of it, but never clears it or turns it off.")}</p>}
                <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                  <button disabled={busy || !current.channelId || !!current.configError} title={tx("Save this log to an .evtx file you choose")} onClick={() => run(() => api.invoke('logs:exportPick', { channelId: current.channelId }), (r) => { if (r) setNote(`Saved a copy of ${current.name} to ${r.path}.`); })}>{tx("Save a copy…")}</button>
                  {!current.guarded && <button disabled={busy || !current.channelId || !!current.configError} title={tx("Empty this log (a copy is saved first and kept)")} onClick={() => setConfirmClear(current)}>{tx("Clear…")}</button>}
                  {!current.guarded && <button disabled={busy || !current.channelId || !!current.configError || current.enabled === null || /^(Application|System)$/i.test(current.name)} title={current.enabled ? tx("Stop recording new events into this log") : tx("Start recording events into this log again")} onClick={() => run(() => api.invoke('logs:setEnabled', { channelId: current.channelId, on: !current.enabled }))}>{current.enabled === null ? tx("Change Recording") : current.enabled ? tx("Turn off") : tx("Turn on")}</button>}
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {confirmClear && (
        <Dialog title={tx("Clear the {p0} log?", { p0: (confirmClear.name) })} onClose={() => setConfirmClear(null)} width={520} buttons={<>
          <button onClick={() => setConfirmClear(null)}>{tx("Keep it")}</button>
          <button className="danger" onClick={() => { const c = confirmClear; setConfirmClear(null); run(() => api.invoke('logs:clear', { channelId: c.channelId }), (r) => setNote(`Cleared ${c.name}. Its copy was kept at ${r.backup}.`)); }}>{tx("Save a copy and clear")}</button>
        </>}>
          <p>{tx("The log will be emptied. First, a copy is saved into Purgeon's log-backups folder and kept — that copy is the only way back.")}</p>
        </Dialog>
      )}
    </Dialog>
  );
}

// Health Check (Tools › System Tools): plain-words answers to "is this PC
// okay?" Nothing is repaired here — each line names the tool that fixes
// it. The run can be cancelled between checks; a check that cannot run
// says so instead of guessing.
export function HealthDialog({ onClose }) {
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);
  const [runSfc, setRunSfc] = useState(false);
  const [weekly, setWeekly] = useState(false);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => { api.invoke('health:weekly').then(setWeekly).catch(() => {}); }, []);

  const start = async () => {
    setRunning(true); setErr(''); setNote(''); setResult(null);
    try { setResult(await api.invoke('health:run', { runSfc })); }
    catch (e) { setErr(e.message); }
    finally { setRunning(false); }
  };
  const BADGE = { pass: ['ok', 'Pass'], warn: ['warn', 'Warning'], fail: ['bad', 'Fail'], unknown: ['', 'Couldn’t check'] };

  return (
    <Dialog title={tx("Health Check")} onClose={onClose} width={760} buttons={<button className="primary" onClick={onClose}>{tx("Close")}</button>}>
      <p className="muted" style={{ marginBottom: 10 }}>{tx("A plain-words once-over: drives, system files, restore points, updates, crashes, startup load and the battery. Nothing is changed or repaired — each line names the tool that fixes it.")}</p>
      {err && <p className="error-text" style={{ marginBottom: 10 }}>{err}</p>}
      {note && <p className="muted" style={{ marginBottom: 10 }}>{tx(note)}</p>}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        {!running
          ? <button className="primary" title={tx("Run the health check now")} onClick={start}>{result ? tx("Run again") : tx("Run the check")}</button>
          : <button className="danger" title={tx("Stop the check at the next step")} onClick={() => api.invoke('health:cancel')}>{tx("Cancel")}</button>}
        <label className="power-cell power-check">
          <input type="checkbox" checked={runSfc} disabled={running} title={tx("Also verify every Windows system file, not just the quick store check. Takes a few minutes.")} onChange={(e) => setRunSfc(e.target.checked)} />{tx("Also verify every system file (slower)")}</label>
        <label className="power-cell power-check">
          <input type="checkbox" checked={weekly} title={tx("Add the health check (without the slow file verification) to the weekly maintenance run. Maintenance itself is set up in Tools.")} onChange={(e) => { setWeekly(e.target.checked); api.invoke('health:setWeekly', { on: e.target.checked }).catch((x) => setErr(x.message)); }} />{tx("Add to Weekly Maintenance")}</label>
      </div>
      {running && <p className="muted">{tx("Checking… (drive health, system files, restore points, updates, crashes, startup, battery)")}</p>}
      {result && (
        <>
          <p style={{ fontSize: 14, marginBottom: 10 }}>{result.summary.text}{result.cancelled ? tx(" (The run was cancelled, so this covers only the checks that finished.)") : ''}</p>
          <div style={{ marginBottom: 12 }}>
            {result.checks.map((c) => (
              <div key={c.id + c.label} className="pkg-row" style={{ cursor: 'default' }}>
                <span className="pkg-name">{tx(c.label)}</span>
                <span className="muted" style={{ flex: 1 }}>{tx(c.detail)}</span>
                <span className={`pkg-badge ${BADGE[c.status]?.[0] || ''}`}>{BADGE[c.status]?.[1] || c.status}</span>
              </div>
            ))}
          </div>
          <button disabled={running} title={tx("Save this report as a text file")} onClick={async () => { try { const r = await api.invoke('health:saveReport', { result }); if (r) setNote(`Report saved to ${r.path}.`); } catch (e) { setErr(e.message); } }}>{tx("Save Report…")}</button>
        </>
      )}
    </Dialog>
  );
}

// Scheduled Tasks (Tools › System Tools): everything Windows runs on a
// schedule. Windows' own tasks are badged and can be run or turned off
// but never deleted here; deleting anything else saves its definition
// first, and Change History's undo re-registers it from that copy.
export function TasksDialog({ onClose }) {
  const [items, setItems] = useState(null);
  const [selected, setSelected] = useState(0);
  const [filter, setFilter] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [creating, setCreating] = useState(false);

  const load = () => api.invoke('tasks:list').then(setItems).catch((e) => { setItems([]); setErr(e.message); });
  useEffect(() => { load(); }, []);
  const run = async (fn) => {
    setBusy(true); setErr('');
    try { await fn(); await load(); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const shown = (items || []).filter((t) => !filter || `${t.path}${t.name}`.toLowerCase().includes(filter.toLowerCase()));
  const current = shown.length ? shown[Math.min(selected, shown.length - 1)] : null;
  const fmtWhen = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
  const resultText = (r) => (r === null || r === undefined ? '—' : r === 0 ? 'Ran fine' : `Finished with code ${r}`);

  return (
    <Dialog title={tx("Scheduled Tasks")} onClose={onClose} width={900} buttons={<>
      <button disabled={busy} title={tx("Create a simple task: run a program at sign-in, daily or weekly")} onClick={() => setCreating(true)}>{tx("New Task…")}</button>
      <button className="primary" onClick={onClose}>{tx("Close")}</button>
    </>}>
      <p className="muted" style={{ marginBottom: 10 }}>{tx("Everything Windows runs on a schedule. Windows' own tasks are badged — they can be run or turned off here, but never deleted.")}</p>
      {err && <p className="error-text" style={{ marginBottom: 10 }}>{err}</p>}
      <input className="search-input" style={{ marginBottom: 10, width: '100%' }} placeholder={tx("Search tasks…")} title={tx("Type part of a task's name or folder to filter the list")} value={filter} onChange={(e) => { setFilter(e.target.value); setSelected(0); }} />
      {items === null ? <p className="muted">{tx("Reading the tasks…")}</p> : shown.length === 0 ? <p className="muted">{tx("No tasks match.")}</p> : (
        <div className="recovery-cols">
          <div className="pkg-list">
            {shown.map((t, i) => (
              <button key={t.path + t.name} className={`pkg-row ${current && t.name === current.name && t.path === current.path ? 'sel' : ''}`} onClick={() => setSelected(i)}>
                <span className="pkg-name">{t.name}<span className="muted" style={{ display: 'block', fontSize: 11.5 }}>{t.path}</span></span>
                {t.isWindows ? <span className="pkg-badge warn">{tx("Windows")}</span> : t.state === 'Disabled' ? <span className="pkg-badge warn">{tx("Off")}</span> : null}
              </button>
            ))}
          </div>
          <div className="pkg-entries">
            {current && (
              <>
                <div className="pkg-entries-head">{current.name}</div>
                <div className="pkg-entry"><span className="muted">{tx("Folder")}</span><span style={{ marginLeft: 'auto' }}>{current.path}</span></div>
                <div className="pkg-entry"><span className="muted">{tx("State")}</span><span style={{ marginLeft: 'auto' }}>{current.state}</span></div>
                {current.author && <div className="pkg-entry"><span className="muted">{tx("Author")}</span><span style={{ marginLeft: 'auto' }}>{current.author}</span></div>}
                <div className="pkg-entry"><span className="muted">{tx("Last run")}</span><span style={{ marginLeft: 'auto' }}>{fmtWhen(current.lastRun)}</span></div>
                <div className="pkg-entry"><span className="muted">{tx("Last result")}</span><span style={{ marginLeft: 'auto' }}>{resultText(current.lastResult)}</span></div>
                <div className="pkg-entry"><span className="muted">{tx("Next run")}</span><span style={{ marginLeft: 'auto' }}>{fmtWhen(current.nextRun)}</span></div>
                <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                  <button disabled={busy} title={tx("Run this task right now")} onClick={() => run(() => api.invoke('tasks:runNow', { task: current }))}>{tx("Run now")}</button>
                  <button disabled={busy} title={tx("Stop this task if it is running")} onClick={() => run(() => api.invoke('tasks:stop', { task: current }))}>{tx("Stop")}</button>
                  <button disabled={busy} title={current.state === 'Disabled' ? tx("Let this task run on its schedule again") : tx("Keep the task but stop it running on its schedule")} onClick={() => run(() => api.invoke('tasks:setEnabled', { task: current, on: current.state === 'Disabled' }))}>{current.state === 'Disabled' ? tx("Turn on") : tx("Turn off")}</button>
                  {!current.isWindows && <button disabled={busy} className="danger" title={tx("Delete this task (its definition is saved first, and Change History can undo)")} onClick={() => setConfirmDelete(current)}>{tx("Delete…")}</button>}
                </div>
                {current.isWindows && <p className="muted" style={{ marginTop: 10 }}>{tx("One of Windows' own tasks — it can be run or turned off here, but not deleted.")}</p>}
              </>
            )}
          </div>
        </div>
      )}
      {confirmDelete && (
        <Dialog title={tx("Delete {p0}?", { p0: (confirmDelete.name) })} onClose={() => setConfirmDelete(null)} width={520} buttons={<>
          <button onClick={() => setConfirmDelete(null)}>{tx("Keep it")}</button>
          <button className="danger" onClick={() => { const t = confirmDelete; setConfirmDelete(null); run(() => api.invoke('tasks:remove', { task: t })); }}>{tx("Delete it")}</button>
        </>}>
          <p>{tx("Its definition is saved to Purgeon's task-backups folder first, and Change History's undo puts it back from that copy.")}</p>
        </Dialog>
      )}
      {creating && <TaskCreateDialog onClose={() => setCreating(false)} onDone={() => { setCreating(false); load(); }} />}
    </Dialog>
  );
}

function TaskCreateDialog({ onClose, onDone }) {
  const [name, setName] = useState('');
  const [program, setProgram] = useState('');
  const [trigger, setTrigger] = useState('daily');
  const [time, setTime] = useState('09:00');
  const [day, setDay] = useState('Monday');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true); setErr('');
    try { await api.invoke('tasks:create', { name, program, trigger, time, day }); onDone(); }
    catch (e) { setErr(e.message); setBusy(false); }
  };
  return (
    <Dialog title={tx("New Task")} onClose={onClose} width={560} buttons={<>
      <button onClick={onClose}>{tx("Cancel")}</button>
      <button className="primary" disabled={busy || !name.trim() || !program} onClick={create}>{tx("Create the task")}</button>
    </>}>
      {err && <p className="error-text" style={{ marginBottom: 10 }}>{err}</p>}
      <label className="field">{tx("Name")}<input value={name} title={tx("What the task is called in the list")} onChange={(e) => setName(e.target.value)} placeholder={tx("e.g. Back up my photos")} />
      </label>
      <label className="field">{tx("Program")}<span style={{ display: 'flex', gap: 8 }}>
          <input value={program} title={tx("The program file the task runs")} onChange={(e) => setProgram(e.target.value)} placeholder={tx("C:\\\\Path\\\\program.exe")} style={{ flex: 1 }} />
          <button title={tx("Choose the program file")} onClick={async () => { const f = await api.invoke('tasks:pickProgram'); if (f) setProgram(f); }}>{tx("Choose…")}</button>
        </span>
      </label>
      <label className="field">{tx("When")}<select value={trigger} title={tx("When the task runs")} onChange={(e) => setTrigger(e.target.value)}>
          <option value="logon">{tx("When I sign in")}</option>
          <option value="daily">{tx("Every day")}</option>
          <option value="weekly">{tx("Every week")}</option>
        </select>
      </label>
      {trigger !== 'logon' && (
        <div style={{ display: 'flex', gap: 10 }}>
          {trigger === 'weekly' && (
            <label className="field" style={{ flex: 1 }}>{tx("Day")}<select value={day} title={tx("The day of the week")} onChange={(e) => setDay(e.target.value)}>
                {['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </label>
          )}
          <label className="field" style={{ flex: 1 }}>{tx("Time")}<input value={time} title={tx("The time of day, like 09:00")} onChange={(e) => setTime(e.target.value)} placeholder="09:00" />
          </label>
        </div>
      )}
    </Dialog>
  );
}
