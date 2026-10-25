import { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog } from './dialogs.jsx';

const fmt = (b) => (!b ? '0 B' : b < 1048576 ? `${(b / 1024).toFixed(0)} KB` : b < 1073741824 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1073741824).toFixed(2)} GB`);

function Picker({ items, chosen, setChosen, render, disabled = () => false }) {
  const toggle = (id) =>
    setChosen((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  return (
    <div className="tree">
      {items.map((i) => (
        <label key={i.id} className={`tree-item ${disabled(i) ? 'info' : ''}`}>
          <input type="checkbox" disabled={disabled(i)} checked={chosen.has(i.id)} onChange={() => toggle(i.id)} />
          {render(i)}
        </label>
      ))}
    </div>
  );
}

// ---- 1. uninstall queue ---------------------------------------------------------------------

const STATUS = { pending: 'Waiting', done: 'Uninstalled', failed: 'Problem', skipped: 'Skipped' };
export function QueueDialog({ queue, onStart, onRemove, onClear, onClose }) {
  const programs = queue?.programs || [];
  const pending = programs.filter((p) => p.status === 'pending').length;
  return (
    <Dialog
      title="Uninstall Queue"
      onClose={onClose}
      width={720}
      buttons={
        <>
          <span className="button-hint">{pending} waiting</span>
          <button className="primary" disabled={!pending} onClick={onStart}>
            {programs.some((p) => p.status !== 'pending') ? 'Continue' : 'Start'}
          </button>
          <button disabled={!programs.length} onClick={onClear}>
            Clear Queue
          </button>
          <button onClick={onClose}>Close</button>
        </>
      }
    >
      <p className="heading">Programs are uninstalled one after another, silently where possible, so you don't have to watch. If one needs a restart, SweepUninstall continues after you sign back in. At the end, every leftover is shown at once for you to review.</p>
      {!programs.length && <div className="empty-box">The queue is empty. Right-click programs and choose Add to Uninstall Queue.</div>}
      <div className="tree">
        {programs.map((p) => (
          <div key={p.key} className={`tree-item queue-${p.status}`}>
            <span className="path">
              <b>{p.name}</b> <span className="muted">{p.version}</span>
            </span>
            <span className="muted">
              {STATUS[p.status]}
              {p.detail ? ` · ${p.detail}` : ''}
            </span>
            {p.status === 'pending' && (
              <button className="link" onClick={() => onRemove(p.key)}>
                Remove
              </button>
            )}
          </div>
        ))}
      </div>
      {queue?.leftovers?.length > 0 && <p className="footnote">{queue.leftovers.length} leftovers found so far; they are shown when the queue finishes.</p>}
    </Dialog>
  );
}

// ---- 2. removed outside SweepUninstall ------------------------------------------------------------

export function OutsideDialog({ programs, onScan, onClose }) {
  const [chosen, setChosen] = useState(() => new Set(programs.map((p) => p.key)));
  return (
    <Dialog
      title="Programs Removed Elsewhere"
      onClose={onClose}
      width={620}
      buttons={
        <>
          <button className="primary" disabled={!chosen.size} onClick={() => onScan(programs.filter((p) => chosen.has(p.key)))}>
            Scan for Leftovers
          </button>
          <button onClick={onClose}>Not Now</button>
        </>
      }
    >
      <p className="heading">
        {programs.length === 1 ? 'This program was' : 'These programs were'} uninstalled since SweepUninstall last looked, from Windows Settings, its own uninstaller or another tool. Uninstallers often leave files and settings behind.
      </p>
      <Picker
        items={programs.map((p) => ({ ...p, id: p.key }))}
        chosen={chosen}
        setChosen={setChosen}
        render={(p) => (
          <span className="path">
            <b>{p.name}</b> <span className="muted">{[p.version, p.publisher].filter(Boolean).join(' · ')}</span>
          </span>
        )}
      />
      <p className="footnote">They are also recorded in View › Uninstall Archive.</p>
    </Dialog>
  );
}

// ---- 3. trial installs ------------------------------------------------------------------------

export function TrialsDialog({ trials, onNew, onTryOver, onKeep, onClose }) {
  return (
    <Dialog title="Trial Installs" onClose={onClose} width={680} buttons={<><button className="primary" onClick={onNew}>Start a Trial…</button><button onClick={onClose}>Close</button></>}>
      <p className="heading">Try a program and undo it completely. A snapshot is taken, the installer runs, and you use the program. Then <b>Try Over</b> removes everything added since, including what the program created while you tried it, and puts changed settings back.</p>
      {!trials.length && <div className="empty-box">No trials running.</div>}
      <div className="tree">
        {trials.map((t) => (
          <div key={t.id} className="tree-item">
            <span className="path">
              <b>{t.name}</b> <span className="muted">since {new Date(t.started).toLocaleString()}</span>
            </span>
            <button className="link" onClick={() => onTryOver(t)}>
              Try Over…
            </button>
            <button className="link" onClick={() => onKeep(t)}>
              Keep It
            </button>
          </div>
        ))}
      </div>
      <p className="footnote">Close other programs during a trial: anything else that changes is part of the trial too, and Try Over shows the full list for you to review first.</p>
    </Dialog>
  );
}

// ---- 5. disk-space map ------------------------------------------------------------------------

// Squarified treemap layout of values into a w×h rectangle: [{ item, x, y, w, h }].
export function treemap(items, w, h) {
  const total = items.reduce((n, i) => n + i.value, 0);
  if (!total) return [];
  const scale = (w * h) / total;
  const out = [];
  let rest = items.map((i) => ({ item: i, area: i.value * scale }));
  let x = 0;
  let y = 0;
  let W = w;
  let H = h;
  const worst = (row, side) => {
    const s = row.reduce((n, r) => n + r.area, 0);
    return Math.max(...row.map((r) => Math.max((side * side * r.area) / (s * s), (s * s) / (side * side * r.area))));
  };
  while (rest.length) {
    const side = Math.min(W, H);
    let row = [rest[0]];
    let i = 1;
    while (i < rest.length && worst([...row, rest[i]], side) <= worst(row, side)) row.push(rest[i++]);
    rest = rest.slice(i);
    const sum = row.reduce((n, r) => n + r.area, 0);
    if (W >= H) {
      const cw = sum / H;
      let cy = y;
      for (const r of row) out.push({ item: r.item, x, y: cy, w: cw, h: r.area / cw }), (cy += r.area / cw);
      x += cw;
      W -= cw;
    } else {
      const ch = sum / W;
      let cx = x;
      for (const r of row) out.push({ item: r.item, x: cx, y, w: r.area / ch, h: ch }), (cx += r.area / ch);
      y += ch;
      H -= ch;
    }
  }
  return out;
}

const COLORS = ['#2f6f4f', '#2b5f7a', '#6a4f8a', '#7a5a2b', '#7a2f3f', '#3f6f6a', '#5a6a2b', '#4f4f7a'];
export function DiskMapDialog({ data, onAnalyze, onSheet, onClose }) {
  const [sel, setSel] = useState(null);
  const top = data.slice(0, 60);
  const others = data.slice(60).reduce((n, x) => n + x.total, 0);
  const boxes = useMemo(() => treemap([...top.map((d) => ({ ...d, value: d.total })), ...(others ? [{ key: '__others', name: `${data.length - 60} others`, value: others, total: others, install: others, data: [] }] : [])], 100, 100), [data]); // eslint-disable-line react-hooks/exhaustive-deps
  const total = data.reduce((n, d) => n + d.total, 0);
  const p = sel && data.find((d) => d.key === sel);
  return (
    <Dialog title="Disk Space Map" onClose={onClose} width={960} buttons={<button className="primary" onClick={onClose}>Close</button>}>
      <p className="heading">
        {fmt(total)} used by {data.length} programs: their install folders plus the data folders named after them. Click a block for details.
      </p>
      <div className="treemap" role="list">
        {boxes.map((b, i) => (
          <button
            key={b.item.key}
            role="listitem"
            className={`tm-box ${sel === b.item.key ? 'on' : ''}`}
            style={{ left: `${b.x}%`, top: `${b.y}%`, width: `${b.w}%`, height: `${b.h}%`, background: COLORS[i % COLORS.length] }}
            title={`${b.item.name}: ${fmt(b.item.total)}`}
            onClick={() => b.item.key !== '__others' && setSel(b.item.key)}
          >
            {b.w * b.h > 18 && (
              <span>
                {b.item.name}
                <br />
                <small>{fmt(b.item.total)}</small>
              </span>
            )}
          </button>
        ))}
      </div>
      {p && (
        <div className="tm-detail">
          <b>{p.name}</b> · {fmt(p.total)} · program {fmt(p.install)}
          {p.data.length > 0 && ` · data ${fmt(p.data.reduce((n, d) => n + d.bytes, 0))}`}
          <div className="tm-data">
            {p.data.slice(0, 6).map((d) => (
              <div key={d.path}>
                <span className="path">{d.path}</span> <span className="muted">{fmt(d.bytes)}</span>
              </div>
            ))}
          </div>
          <span className="plan-actions">
            <button onClick={() => onSheet(p.key)}>What It Does…</button>
            <button onClick={() => onAnalyze(p.key)}>Analyze Leftovers…</button>
          </span>
        </div>
      )}
    </Dialog>
  );
}

// ---- 7. what a program does ------------------------------------------------------------------------

export function SheetDialog({ program, sections, onAnalyze, onClose }) {
  return (
    <Dialog
      title={`What It Does – ${program.name}`}
      onClose={onClose}
      width={760}
      buttons={
        <>
          <button onClick={onAnalyze}>Analyze Leftovers…</button>
          <button className="primary" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <p className="heading">Everything {program.name} hooks into Windows that SweepUninstall can see.</p>
      {!sections.length && <div className="empty-box">Nothing beyond its own folder.</div>}
      {sections.map((s) => (
        <div key={s.id} className="sheet-section">
          <div className="tree-group">
            <b>{s.label}</b> <span className="muted">({s.items.length})</span>
          </div>
          {s.items.map((i, n) => (
            <div key={n} className="tree-item">
              <span className="path">
                {i.path}
                {i.name ? `  ›  ${i.name}` : ''}
              </span>
              <span className="muted">{i.reason}</span>
            </div>
          ))}
        </div>
      ))}
    </Dialog>
  );
}

// ---- 8. registry search / small prompts --------------------------------------------------------------

export function PromptDialog({ title, heading, label, placeholder, initial = '', action, onSubmit, onClose, note }) {
  const [v, setV] = useState(initial);
  return (
    <Dialog title={title} onClose={onClose} width={560} buttons={<><button className="primary" disabled={!v.trim()} onClick={() => onSubmit(v.trim())}>{action}</button><button onClick={onClose}>Cancel</button></>}>
      <p className="heading">{heading}</p>
      <label className="field">
        {label}
        <input autoFocus value={v} placeholder={placeholder} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && v.trim() && onSubmit(v.trim())} />
      </label>
      {note && <p className="footnote">{note}</p>}
    </Dialog>
  );
}

// ---- 10. new startup entries ------------------------------------------------------------------------

export function StartupAlertDialog({ entries, onAllow, onDisable, onClose }) {
  return (
    <Dialog title="New Startup Entries" onClose={onClose} width={720} buttons={<><button onClick={() => onAllow(entries)}>Allow All</button><button className="primary" onClick={onClose}>Decide Later</button></>}>
      <p className="heading">{entries.length === 1 ? 'A program added itself' : `${entries.length} programs added themselves`} to what starts with Windows.</p>
      <div className="tree">
        {entries.map((e) => (
          <div key={e.id} className="tree-item">
            <span className="path">
              <b>{e.name}</b> <span className="muted">{[e.company, e.where].filter(Boolean).join(' · ')}</span>
              <br />
              <span className="muted">{e.command}</span>
            </span>
            <button className="link" onClick={() => onAllow([e])}>
              Allow
            </button>
            <button className="link" onClick={() => onDisable(e)}>
              Turn Off
            </button>
          </div>
        ))}
      </div>
      <p className="footnote">Turning one off never deletes it; you can turn it back on in Startup & Services.</p>
    </Dialog>
  );
}

// ---- 11. browsers ------------------------------------------------------------------------------

export function BrowsersDialog({ data, running, onRemove, onClose }) {
  const removable = data.extensions.filter((e) => e.removable.length);
  const [chosen, setChosen] = useState(() => new Set(removable.map((e) => `${e.browser}|${e.profile}|${e.id}`)));
  const id = (e) => `${e.browser}|${e.profile}|${e.id}`;
  const blocked = (e) => !e.removable.length || running.some((r) => ({ chrome: 'chrome', edge: 'msedge', brave: 'brave', firefox: 'firefox' })[e.browser] === r);
  return (
    <Dialog
      title="Browser Clean-up"
      onClose={onClose}
      width={820}
      buttons={
        <>
          <span className="button-hint">{[...chosen].length} selected</span>
          <button className="primary" disabled={![...chosen].length} onClick={() => onRemove(removable.filter((e) => chosen.has(id(e)) && !blocked(e)))}>
            Remove Selected
          </button>
          <button onClick={onClose}>Close</button>
        </>
      }
    >
      <p className="heading">Extensions that a program added on its own are flagged and can be removed here, with a backup. Extensions you added yourself are listed for reference; remove those in the browser.</p>
      {running.length > 0 && <div className="safe-note">Close {running.join(', ')} to remove its extensions.</div>}
      <div className="tree">
        {data.extensions.map((e) => (
          <label key={id(e)} className={`tree-item ${blocked(e) ? 'info' : ''}`}>
            <input
              type="checkbox"
              disabled={blocked(e)}
              checked={chosen.has(id(e)) && !blocked(e)}
              onChange={() =>
                setChosen((s) => {
                  const n = new Set(s);
                  n.has(id(e)) ? n.delete(id(e)) : n.add(id(e));
                  return n;
                })
              }
            />
            <span className="path">
              <b>{e.name}</b> <span className="muted">{[e.browserName, e.profile, e.version].filter(Boolean).join(' · ')}</span>
            </span>
            <span className={`insight-tag ${e.addedBy === 'program' ? 'offer' : 'together'}`}>{e.addedBy === 'program' ? (e.pendingInstall ? 'added by a program (waiting)' : 'added by a program') : e.addedBy === 'policy' ? 'by policy' : 'added by you'}</span>
          </label>
        ))}
      </div>
      {data.settings.length > 0 && (
        <p className="footnote">
          {data.settings.map((s) => `${s.browserName} (${s.profile}): search ${s.search || 'default'}${s.home ? `, home page ${s.home}` : ''}`).join(' · ')}
        </p>
      )}
    </Dialog>
  );
}

// ---- 13-14. whole-PC migration, folder restore, settings sync -------------------------------------------

export function MigratePcDialog({ programs, onSave, onClose }) {
  const [mode, setMode] = useState('all');
  const [chosen, setChosen] = useState(() => new Set());
  return (
    <Dialog
      title="Migrate This PC"
      onClose={onClose}
      width={760}
      buttons={
        <>
          <span className="button-hint">{chosen.size} programs</span>
          <button className="primary" disabled={!chosen.size} onClick={() => onSave(programs.filter((p) => chosen.has(p.key)), mode)}>
            Save to Folder…
          </button>
          <button onClick={onClose}>Cancel</button>
        </>
      }
    >
      <p className="heading">Packs the chosen programs into one folder, one package each, plus a winget list of all your programs. On the new PC, use File › Restore Programs From Folder, and run winget import for the rest.</p>
      <div className="mode-row">
        {[
          ['all', 'Programs and my settings'],
          ['program', 'Programs only'],
          ['settings', 'My settings only'],
        ].map(([id, label]) => (
          <label key={id} className={`preset ${mode === id ? 'on' : ''}`}>
            <input type="radio" checked={mode === id} onChange={() => setMode(id)} /> <b>{label}</b>
          </label>
        ))}
      </div>
      <Picker
        items={programs.map((p) => ({ ...p, id: p.key }))}
        chosen={chosen}
        setChosen={setChosen}
        render={(p) => (
          <span className="path">
            {p.name} <span className="muted">{p.sizeKB ? fmt(p.sizeKB * 1024) : ''}</span>
          </span>
        )}
      />
    </Dialog>
  );
}

export function FolderRestoreDialog({ folder, packages, onRestore, onClose }) {
  const [chosen, setChosen] = useState(() => new Set(packages.map((p) => p.file)));
  return (
    <Dialog
      title="Restore Programs From Folder"
      onClose={onClose}
      width={680}
      buttons={
        <>
          <button className="primary" disabled={!chosen.size} onClick={() => onRestore(packages.filter((p) => chosen.has(p.file)))}>
            Restore {chosen.size}
          </button>
          <button onClick={onClose}>Cancel</button>
        </>
      }
    >
      <p className="heading">{packages.length} program packages in {folder}. Each is restored with the usual checks: nothing existing is overwritten, and each restore can be undone from Change History.</p>
      <Picker items={packages.map((p) => ({ ...p, id: p.file }))} chosen={chosen} setChosen={setChosen} render={(p) => <span className="path">{p.name}</span>} />
    </Dialog>
  );
}

export function SyncDialog({ settings, programs, onSave, onPush, onPull, onPickFolder, onClose }) {
  const [folder, setFolder] = useState(settings.syncFolder || '');
  const [chosen, setChosen] = useState(() => new Set(settings.syncKeys || []));
  const current = () => ({ syncFolder: folder, syncKeys: [...chosen] });
  return (
    <Dialog
      title="Settings Sync"
      onClose={onClose}
      width={720}
      buttons={
        <>
          <button disabled={!folder || !chosen.size} onClick={() => onPush(current())}>
            Send My Settings
          </button>
          <button disabled={!folder} onClick={() => onPull(current())}>
            Get Settings
          </button>
          <button className="primary" onClick={() => onSave(current())}>
            Save
          </button>
          <button onClick={onClose}>Cancel</button>
        </>
      }
    >
      <p className="heading">Keep chosen programs' settings the same on your PCs through a shared folder, such as one in OneDrive. <b>Send</b> saves this PC's settings there; <b>Get</b> brings in newer settings from another PC.</p>
      <div className="field-row">
        <input readOnly value={folder} placeholder="Choose a shared folder" />
        <button onClick={async () => setFolder((await onPickFolder()) || folder)}>Folder…</button>
      </div>
      <Picker items={programs.map((p) => ({ ...p, id: p.key }))} chosen={chosen} setChosen={setChosen} render={(p) => <span className="path">{p.name}</span>} />
      <p className="footnote">Getting settings replaces a program's current settings; they go to the Recycle Bin first and the change can be undone from Change History. Close the programs first.</p>
    </Dialog>
  );
}

// ---- 15. portable apps ------------------------------------------------------------------------------

export function PortableDialog({ apps, onRegister, onUnregister, onAddFolder, onClose }) {
  return (
    <Dialog title="Portable Apps" onClose={onClose} width={780} buttons={<><button onClick={onAddFolder}>Add a Folder…</button><button className="primary" onClick={onClose}>Close</button></>}>
      <p className="heading">Programs that run from a folder without being installed, so Windows doesn't list them. Registering one adds it to the program list with its icon, so it gets groups, leftover scans and a clean removal.</p>
      {!apps.length && <div className="empty-box">No portable apps found in the usual places. Use Add a Folder to point to one.</div>}
      <div className="tree">
        {apps.map((a) => (
          <div key={a.folder} className="tree-item">
            <span className="path">
              <b>{a.name}</b> <span className="muted">{[a.publisher, a.version].filter(Boolean).join(' · ')}</span>
              <br />
              <span className="muted">{a.folder}</span>
            </span>
            {a.registered ? (
              <button className="link" onClick={() => onUnregister(a)}>
                Unregister
              </button>
            ) : (
              <button className="link" onClick={() => onRegister(a)}>
                Register
              </button>
            )}
          </div>
        ))}
      </div>
    </Dialog>
  );
}

// ---- 17. command palette ------------------------------------------------------------------------------

export function CommandPalette({ commands, onRun, onClose }) {
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const ref = useRef(null);
  const shown = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return commands.filter((c) => words.every((w) => c.text.toLowerCase().includes(w))).slice(0, 40);
  }, [q, commands]);
  useEffect(() => {
    setI(0);
  }, [q]);
  // Block bodies: scrollIntoView now returns a Promise, which must not become the effect's clean-up.
  useEffect(() => {
    ref.current?.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  }, [i]);
  return (
    <div className="overlay palette-overlay" onMouseDown={onClose}>
      <div className="palette" role="dialog" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          value={q}
          placeholder="Type a command or a program name…"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') (e.preventDefault(), setI((x) => Math.min(shown.length - 1, x + 1)));
            else if (e.key === 'ArrowUp') (e.preventDefault(), setI((x) => Math.max(0, x - 1)));
            else if (e.key === 'Enter' && shown[i]) onRun(shown[i]);
            else if (e.key === 'Escape') onClose();
          }}
        />
        <div className="palette-list" ref={ref} role="listbox">
          {shown.map((c, n) => (
            <button key={c.id} role="option" aria-selected={n === i} className={n === i ? 'on' : ''} onMouseEnter={() => setI(n)} onClick={() => onRun(c)}>
              <span>{c.text}</span>
              <span className="accel">{c.hint || ''}</span>
            </button>
          ))}
          {!shown.length && <div className="muted palette-empty">Nothing matches.</div>}
        </div>
      </div>
    </div>
  );
}

// ---- 19. monthly report ---------------------------------------------------------------------------------

export function ReportDialog({ onMake, onClose }) {
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  return (
    <Dialog title="Monthly Report" onClose={onClose} width={520} buttons={<><button className="primary" disabled={!/^\d{4}-\d{2}$/.test(month)} onClick={() => onMake(month)}>Save Report…</button><button onClick={onClose}>Cancel</button></>}>
      <p className="heading">An HTML report of a month: programs installed and removed, space freed, startup changes, updates, clean-ups, and programs flagged by the insights.</p>
      <label className="field">
        Month
        <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
      </label>
    </Dialog>
  );
}

// ---- 21. Explorer context menu items --------------------------------------------------------------

export function ContextMenuDialog({ entries, admin, onToggle, onRestartExplorer, onClose }) {
  const [working, setWorking] = useState(null);
  const places = [...new Set(entries.map((e) => e.place))];
  const toggle = async (e) => {
    setWorking(e.id);
    try {
      await onToggle(e);
    } finally {
      setWorking(null);
    }
  };
  return (
    <Dialog
      title="Explorer Context Menu"
      onClose={onClose}
      width={820}
      buttons={
        <>
          <button onClick={onRestartExplorer}>Restart Explorer</button>
          <button className="primary" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <p className="heading">Right-click entries that programs added to Explorer. Click one to turn it on or off; nothing is deleted. Changes show in new Explorer windows, or everywhere after Restart Explorer.</p>
      {!entries.length && <div className="empty-box">No right-click entries from other programs were found.</div>}
      {places.map((place) => (
        <section key={place} className="tweak-group">
          <div className="tweak-group-head">
            <span>{place}</span>
            <span className="muted">
              {entries.filter((e) => e.place === place && e.enabled).length}/{entries.filter((e) => e.place === place).length} on
            </span>
          </div>
          {entries
            .filter((e) => e.place === place)
            .map((e) => (
              <button key={e.id} className={`tweak ${e.enabled ? 'on' : 'off'} ${working === e.id ? 'busy' : ''}`} onClick={() => toggle(e)} aria-pressed={e.enabled} title={e.file}>
                <span className={`pill ${e.enabled ? 'on' : 'off'}`}>{working === e.id ? '…' : e.enabled ? 'ON' : 'OFF'}</span>
                <span className="tweak-text">
                  <span className="tweak-title">{e.name}</span>
                  <span className="tweak-detail">{[e.company, e.type === 'extension' ? 'Shell extension' : 'Menu command', e.file].filter(Boolean).join(' · ')}</span>
                </span>
                <span className="tweak-tags">
                  <span className="tag-row">
                    {e.windows && <span className="fx fx-windows">Windows</span>}
                    {e.admin && <span className={`fx fx-admin ${admin === false ? 'warn' : ''}`}>Admin</span>}
                  </span>
                </span>
              </button>
            ))}
        </section>
      ))}
      <p className="footnote">On Windows 11, these entries are under Show more options. Each change is in Change History and can be undone.</p>
    </Dialog>
  );
}
