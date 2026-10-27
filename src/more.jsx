import { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog } from './dialogs.jsx';
import * as path from './winpath.js';

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
      <p className="heading">Programs are uninstalled one after another, silently where possible, so you don't have to watch. If one needs a restart, Purgeon continues after you sign back in. At the end, every leftover is shown at once for you to review.</p>
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

// ---- 2. removed outside Purgeon ------------------------------------------------------------

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
        {programs.length === 1 ? 'This program was' : 'These programs were'} uninstalled since Purgeon last looked, from Windows Settings, its own uninstaller or another tool. Uninstallers often leave files and settings behind.
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
            <button onClick={() => onSheet(p.key)}>What’s This…</button>
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
      title={`What’s This – ${program.name}`}
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
      <p className="heading">Everything {program.name} hooks into Windows that Purgeon can see.</p>
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
        <input autoFocus value={v} placeholder={placeholder} title={label} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && v.trim() && onSubmit(v.trim())} />
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
        <input readOnly value={folder} placeholder="Choose a shared folder" title="The shared folder settings are kept in, for example one inside OneDrive. Use Folder to choose it." />
        <button onClick={async () => setFolder((await onPickFolder()) || folder)}>Folder…</button>
      </div>
      <Picker items={programs.map((p) => ({ ...p, id: p.key }))} chosen={chosen} setChosen={setChosen} render={(p) => <span className="path">{p.name}</span>} />
      <p className="footnote">Getting settings replaces a program's current settings; they go to the Recycle Bin first and the change can be undone from Change History. Close the programs first.</p>
    </Dialog>
  );
}

// ---- 15. portable apps ------------------------------------------------------------------------------

export function PortableDialog({ apps, folders = [], updates = null, checking = false, onRegister, onUnregister, onAddFolder, onRemoveFolder, onCheckUpdates, onOpenUrl, onClose }) {
  const upd = (a) => updates?.find((u) => u.folder === a.folder);
  const newer = updates ? updates.filter((u) => u.newer).length : 0;
  return (
    <Dialog
      title="Portable Apps"
      onClose={onClose}
      width={800}
      buttons={
        <>
          {updates && <span className="button-hint">{newer ? `${newer} update${newer === 1 ? '' : 's'} available` : 'No updates found'}</span>}
          <button onClick={onCheckUpdates} disabled={checking || !apps.length} title="Looks up each app in winget’s catalogue (the Windows Package Manager) and shows where a newer version exists, with its download page. Nothing is downloaded or changed.">
            {checking ? 'Checking…' : 'Check for Updates'}
          </button>
          <button onClick={onAddFolder} title="Choose a folder that holds portable apps, such as D:\PortableApps. It is remembered and looked at every time: the folder itself and each folder inside it.">
            Add a Folder…
          </button>
          <button className="primary" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <p className="heading">Programs that run from a folder without being installed, so Windows doesn't list them. Registering one adds it to the program list with its icon, so it gets groups, leftover scans and a clean removal.</p>
      {folders.length > 0 && (
        <div className="portable-folders">
          <span className="muted">Your folders:</span>
          {folders.map((f) => (
            <span key={f} className="chip-folder" title={`Looked at every time, with each folder inside it: ${f}`}>
              {f}
              <button className="link" onClick={() => onRemoveFolder(f)} title="Stop looking in this folder. Nothing in it is changed.">
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
      {!apps.length && <div className="empty-box">No portable apps found in the usual places or your folders. Use Add a Folder to point to the folder that holds them.</div>}
      <div className="tree">
        {apps.map((a) => (
          <div key={a.folder} className="tree-item">
            <span className="path">
              <b>{a.name}</b> <span className="muted">{[a.publisher, a.version].filter(Boolean).join(' · ')}</span>
              {upd(a) && (
                <span
                  className={`insight-tag ${upd(a).newer ? 'growing' : 'together'}`}
                  title={upd(a).found ? `winget package ${upd(a).id}, latest version ${upd(a).latest || 'unknown'}` : 'winget’s catalogue has no package with this exact name, so updates can’t be checked.'}
                >
                  {!upd(a).found ? 'not in winget' : upd(a).newer ? `${upd(a).latest} available` : upd(a).latest ? 'up to date' : 'version unknown'}
                </span>
              )}
              <br />
              <span className="muted">{a.folder}</span>
            </span>
            {upd(a)?.newer && upd(a).homepage && (
              <button className="link" onClick={() => onOpenUrl(upd(a).homepage)} title={`Opens ${upd(a).homepage} in your browser, to download version ${upd(a).latest}. Unpack it over this folder after backing the folder up.`}>
                Download Page
              </button>
            )}
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
          title="Type part of a command or program name; Up and Down choose, Enter runs, Esc closes"
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
        <input type="month" title="The month the report covers" value={month} onChange={(e) => setMonth(e.target.value)} />
      </label>
    </Dialog>
  );
}

// ---- the close button --------------------------------------------------------------------------------

export function CloseDialog({ onAnswer }) {
  const [remember, setRemember] = useState(false);
  return (
    <Dialog
      title="Close Purgeon?"
      onClose={() => onAnswer(null, false)}
      width={540}
      buttons={
        <>
          <button className="primary" onClick={() => onAnswer('tray', remember)}>
            Minimize to Tray
          </button>
          <button onClick={() => onAnswer('exit', remember)}>Exit</button>
          <button onClick={() => onAnswer(null, false)}>Cancel</button>
        </>
      }
    >
      <p className="heading">Keep Purgeon running in the notification area (tray), or exit it completely?</p>
      <p className="muted">In the tray it keeps watching for installers and new startup entries. Left-click its icon to open it again; right-click it to exit.</p>
      <label className="check-row" title="Don’t ask again. View › Close Button Asks brings this question back.">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Remember my choice
      </label>
    </Dialog>
  );
}

// ---- analyze a program ------------------------------------------------------------------------------

export const ARCH_LABEL = { x64: '64-bit (x64)', x86: '32-bit (x86)', arm64: 'ARM64', arm: 'ARM (32-bit)' };

export function AnalysisDialog({ program, data, insight = {}, onUninstall, onSheet, onLeftovers, onClose }) {
  const [open, setOpen] = useState(null);
  const days = data.lastUsed?.time ? Math.floor((Date.now() - new Date(data.lastUsed.time).getTime()) / 86400000) : null;
  const sig = insight.signature;
  // The short verdict: what to expect when removing it.
  const points = [
    data.installer.uninstaller
      ? { tone: 'ok', text: `Removed by its own uninstaller (${data.installer.label})${data.installer.silent ? ', which can run silently' : ''}. Leftovers are scanned afterwards.` }
      : { tone: 'warn', text: 'No uninstaller is registered: use Force, which finds and removes its files and settings with a backup.' },
    data.dependencies.note && { tone: 'warn', text: data.dependencies.note },
    data.running.length > 0 && { tone: 'warn', text: `Running now: ${[...new Set(data.running.map((r) => r.name))].join(', ')}. Removal offers to close ${data.running.length === 1 ? 'it' : 'them'} first.` },
    days !== null && { tone: days > 180 ? 'warn' : 'ok', text: days > 180 ? `Not used for ${days} days: a candidate for removal.` : `Last used ${days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'} ago`}.` },
    sig && sig !== 'Valid' && { tone: 'warn', text: sig === 'NotSigned' ? 'Its program file is not digitally signed, so its publisher can’t be verified.' : `Its signature has a problem: ${sig}.` },
    sig === 'Valid' && insight.signer && { tone: 'ok', text: `Digitally signed by ${insight.signer}.` },
    insight.offer && { tone: 'warn', text: 'Its name matches a kind of program often installed as a bundled offer.' },
    insight.together && { tone: 'warn', text: `Installed at the same time as ${insight.together.join(', ')}.` },
  ].filter(Boolean);
  const fmtB = (b) => fmt(b || 0);
  return (
    <Dialog
      title={`Analyze – ${program.name}`}
      onClose={onClose}
      width={780}
      buttons={
        <>
          <button onClick={onSheet}>What’s This…</button>
          <button onClick={onLeftovers}>Analyze Leftovers…</button>
          <button onClick={onUninstall}>Uninstall…</button>
          <button className="primary" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <p className="heading">
        <b>{program.name}</b> {program.version} {program.publisher ? `· ${program.publisher}` : ''}
      </p>
      <div className="analysis-points">
        {points.map((p, i) => (
          <div key={i} className={`analysis-point ${p.tone}`}>
            {p.text}
          </div>
        ))}
      </div>
      <table className="analysis-table">
        <tbody>
          <tr title="The processor the program’s main file is built for, read from the file itself. .NET programs built for “Any CPU” show as 32-bit here but run as 64-bit.">
            <th>Architecture</th>
            <td>{ARCH_LABEL[data.arch] || (program.arch === 'x86' ? '32-bit (from its registry entry)' : program.arch === 'x64' ? '64-bit (from its registry entry)' : 'Unknown')}</td>
          </tr>
          <tr title="The file Purgeon treats as the program itself">
            <th>Program file</th>
            <td className="path">{data.exe || 'Not found'}</td>
          </tr>
          <tr title="The folder the program is installed in, as its uninstall entry says">
            <th>Folder</th>
            <td className="path">{program.location || 'Not recorded'}</td>
          </tr>
          <tr title="Install folder plus the data folders named after it (in ProgramData and AppData), measured now">
            <th>Disk space</th>
            <td>{data.space ? `${fmtB(data.space.total)} in all: program ${fmtB(data.space.install)}${data.space.data.length ? `, data ${fmtB(data.space.data.reduce((n, d) => n + d.bytes, 0))} in ${data.space.data.length} folder${data.space.data.length === 1 ? '' : 's'}` : ''}` : 'Not measured'}</td>
          </tr>
          <tr title="When any of its program files last ran, from Windows’ Prefetch records">
            <th>Last used</th>
            <td>{data.lastUsed?.time ? new Date(data.lastUsed.time).toLocaleString() : data.lastUsed?.unknown}</td>
          </tr>
          <tr title="How it was installed, which decides how it is uninstalled">
            <th>Installer</th>
            <td>
              {data.installer.label}
              {data.installer.silent ? ' · can uninstall silently' : ''}
            </td>
          </tr>
          {data.dependencies.dependents.length > 0 && (
            <tr title="Installed programs that registered that they need this one">
              <th>Needed by</th>
              <td>{data.dependencies.dependents.join(', ')}</td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="tree-group">
        <b>What it hooks into Windows</b> <span className="muted">(click a line for details)</span>
      </div>
      {!data.hooks.length && <div className="empty-box">Nothing beyond its own folder.</div>}
      {data.hooks.map((h) => (
        <div key={h.id}>
          <button className="link analysis-hook" onClick={() => setOpen(open === h.id ? null : h.id)} title={`Show the ${h.label.toLowerCase()} found for this program`}>
            {open === h.id ? '▾' : '▸'} {h.label}: {h.count}
          </button>
          {open === h.id && (
            <div className="tree">
              {h.items.map((t) => (
                <div key={t} className="tree-item">
                  <span className="path">{t}</span>
                </div>
              ))}
              {h.count > h.items.length && <div className="muted">…and {h.count - h.items.length} more (What’s This lists them all)</div>}
            </div>
          )}
        </div>
      ))}
    </Dialog>
  );
}

// ---- installer spotted while it starts --------------------------------------------------------------

export function InstallerFoundDialog({ installer, onMonitor, onStop, onClose }) {
  return (
    <Dialog
      title="Installer Started"
      onClose={onClose}
      width={620}
      buttons={
        <>
          <button className="primary" onClick={onMonitor}>
            Monitor It
          </button>
          <button onClick={onClose}>Not Now</button>
          <button onClick={onStop}>Stop Detecting</button>
        </>
      }
    >
      <p className="heading">
        <b>{installer.name}</b>
        {installer.company ? ` (${installer.company})` : ''} is being installed. Record what it installs, so it can be removed completely later?
      </p>
      <ol className="steps">
        <li>Leave the installer on its first page. Purgeon takes a snapshot first, usually in under a minute.</li>
        <li>Then install as usual, including any first-run setup.</li>
        <li>
          Come back and click <b>Installation Finished</b>.
        </li>
      </ol>
      <p className="muted path" title="The installer that was spotted">
        {installer.path}
      </p>
      <p className="footnote">If the installer has already begun copying files, what it copied so far is missed; Tools › Monitor an Installation records from the very start. Tools › Detect Installations turns this question off.</p>
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

// ---- PortableApps.com installer generator ---------------------------------------

export function PortableAppsDialog({ programs, onGenerate, onClose }) {
  const [chosen, setChosen] = useState(null);
  const [fields, setFields] = useState({
    name: '',
    version: '1.0.0',
    publisher: '',
    homepage: '',
    description: '',
    startExe: '',
  });

  useEffect(() => {
    if (chosen && !fields.name) setFields({ ...fields, name: chosen.name });
  }, [chosen]);

  const eligible = programs.filter((p) => p.hasProgramFiles);

  return (
    <Dialog
      title="PortableApps.com Installer"
      onClose={onClose}
      width={760}
      buttons={
        <>
          <button disabled={!chosen} onClick={() => onGenerate({ ...fields, monitorId: chosen.id })}>
            Generate Package
          </button>
          <button className="primary" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <p className="heading">
        Create a PortableApps.com package from a monitored installation. Purgeon copies the
        recorded program files into a PortableApps.com folder structure and writes an NSIS
        installer script (.nsi) that you compile with makensis into a .paf.exe.
      </p>
      {!eligible.length && (
        <div className="empty-box">
          No monitored programs with portable files were found. Use Tools › Monitor an
          Installation to record a program first.
        </div>
      )}
      {eligible.length && (
        <>
          <div className="field-row">
            <label>Monitored program</label>
            <select value={chosen?.id || ''} onChange={(e) => setChosen(eligible.find((p) => p.id === e.value) || null)}>
              <option value="">Choose a program…</option>
              {eligible.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}{p.items > 0 ? ` (${p.items} items)` : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="field-row">
            <label>Package name</label>
            <input
              value={fields.name}
              onChange={(e) => setFields({ ...fields, name: e.target.value })}
              placeholder="e.g. FooEditor"
              title="The program name shown in the PortableApps.com menu"
            />
          </div>
          <div className="field-row">
            <label>Version</label>
            <input
              value={fields.version}
              onChange={(e) => setFields({ ...fields, version: e.target.value })}
              placeholder="1.0.0"
            />
          </div>
          <div className="field-row">
            <label>Publisher</label>
            <input
              value={fields.publisher}
              onChange={(e) => setFields({ ...fields, publisher: e.target.value })}
              placeholder="e.g. Example Corp"
            />
          </div>
          <div className="field-row">
            <label>Homepage (optional)</label>
            <input
              value={fields.homepage}
              onChange={(e) => setFields({ ...fields, homepage: e.target.value })}
              placeholder="https://example.com"
            />
          </div>
          <div className="field-row">
            <label>Description (optional)</label>
            <input
              value={fields.description}
              onChange={(e) => setFields({ ...fields, description: e.target.value })}
              placeholder="Portable version of Foo Editor"
            />
          </div>
          <div className="field-row">
            <label>Main executable (optional)</label>
            <input
              value={fields.startExe}
              onChange={(e) => setFields({ ...fields, startExe: e.target.value })}
              placeholder="e.g. FooEditor.exe"
              title="If left blank, Purgeon picks the largest .exe from the recorded files"
            />
          </div>
          <p className="footnote">
            After generating, place a PortableApps.com launcher executable in the package folder
            and compile the .nsi script with NSIS (makensis) to produce the .paf.exe installer.
          </p>
        </>
      )}
    </Dialog>
  );
}

// ---- Trusted publishers dialog -------------------------------------------------------

export function TrustedPublishersDialog({ publishers, onClose }) {
  const [list, setList] = useState(publishers);
  const [newName, setNewName] = useState('');
  const [working, setWorking] = useState(false);

  const addPublisher = async () => {
    const name = newName.trim();
    if (!name) return;
    setWorking(true);
    try {
      await api.invoke('trusted:add', name);
      setList(await api.invoke('trusted:list'));
      setNewName('');
    } catch (e) {
      alert(e.message);
    } finally {
      setWorking(false);
    }
  };

  const removePublisher = async (name) => {
    setWorking(true);
    try {
      await api.invoke('trusted:remove', name);
      setList(await api.invoke('trusted:list'));
    } catch (e) {
      alert(e.message);
    } finally {
      setWorking(false);
    }
  };

  return (
    <Dialog
      title="Trusted Publishers"
      onClose={onClose}
      width={620}
      buttons={
        <>
          <button disabled={!newName.trim() || working} onClick={addPublisher}>
            Add
          </button>
          <button className="primary" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <p className="heading">
        Programs signed by a trusted publisher are never blocked by Safe Mode and are
        excluded from unsigned-program warnings. Add the certificate subject name as it
        appears in the digital signature (for example \"Microsoft Corporation\").
      </p>
      <div className="field-row">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="Publisher name"
          title="Certificate subject name of a trusted publisher"
        />
      </div>
      {!list.length && <div className="empty-box">No trusted publishers yet.</div>}
      {list.length && (
        <div className="tree">
          {list.map((name) => (
            <div key={name} className="tree-item">
              <span className="path">{name}</span>
              <button className="link" onClick={() => removePublisher(name)}>Remove</button>
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}

// ---- Update check dialog --------------------------------------------------------------

export function UpdateCheckDialog({ enabled, lastCheck, onClose }) {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState(null);

  const toggle = async () => {
    await api.invoke('update:enable', !enabled);
    onClose();
  };

  const checkNow = async () => {
    setChecking(true);
    setResult(null);
    try {
      const r = await api.invoke('update:check');
      setResult(r);
    } catch (e) {
      setResult({ enabled: true, update: null, error: e.message });
    } finally {
      setChecking(false);
    }
  };

  return (
    <Dialog
      title="Check for Updates"
      onClose={onClose}
      width={620}
      buttons={
        <>
          <button disabled={checking} onClick={checkNow}>
            {checking ? 'Checking…' : 'Check Now'}
          </button>
          <button className="primary" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <p className="heading">
        Purgeon can optionally ask GitHub whether a newer release exists. Checking is off
        by default and never sends data except a standard HTTPS request to api.github.com.
        It never nags after a dismissal.
      </p>
      <div className="field-row">
        <label>Automatic update checks</label>
        <button
          className={`toggle ${enabled ? 'on' : 'off'}`}
          onClick={toggle}
          aria-pressed={enabled}
          title={enabled ? 'Turn off automatic update checks' : 'Turn on automatic update checks'}
        >
          {enabled ? 'ON' : 'OFF'}
        </button>
      </div>
      {lastCheck && <p className="muted">Last checked: {lastCheck}</p>}
      {checking && <p>Checking GitHub for a newer release…</p>}
      {result && !checking && (
        <div className="tweak-group">
          {result.error && (
            <p className="muted" style={{ color: 'var(--red)' }}>
              Check failed: {result.error}
            </p>
          )}
          {result.update && result.update.newer && (
            <>
              <p>
                <b>Update available:</b> {result.update.version}{result.update.name ? ` · ${result.update.name}` : ''}
              </p>
              {result.update.body && <p className="muted">{result.update.body}</p>}
              <p>
                <a href={result.update.url} target="_blank" rel="noopener noreferrer">Download from GitHub Releases</a>
              </p>
            </>
          )}
          {result.update && !result.update.newer && (
            <p>No update available — you have the latest version.</p>
          )}
        </div>
      )}
    </Dialog>
  );
}

// ---- make portable dialog -------------------------------------------------------

// ---- make portable dialog -------------------------------------------------------

export function MakePortableDialog({ program, items, name, publisher, version, onGenerate, onClose }) {
  const [bugDismissed, setBugDismissed] = useState(false);
  const [fields, setFields] = useState({
    name: name || program.name || '',
    version: version || '1.0.0',
    publisher: publisher || '',
    homepage: '',
    description: `Portable version of ${program.name || ''}`,
    startExe: '',
  });
  const [saving, setSaving] = useState(false);

  // Collect .exe candidates from the items for the main executable suggestion.
  const exes = useMemo(() => {
    if (!items || !items.length) return [];
    return items
      .filter((i) => i.kind === 'file' && /\.exe$/i.test(i.path || ''))
      .map((i) => i.path)
      .slice(0, 20);
  }, [items]);

  useEffect(() => {
    if (exes.length && !fields.startExe) {
      setFields({ ...fields, startExe: path.basename(exes[0]) });
    }
  }, [exes]);

  const generatePackage = async () => {
    if (!fields.name.trim()) return;
    setSaving(true);
    try {
      await onGenerate({
        monitorId: program.id || undefined,
        appName: fields.name.trim(),
        appVersion: fields.version.trim() || '1.0.0',
        appPublisher: fields.publisher.trim() || 'Unknown',
        appHomepage: fields.homepage.trim(),
        appDescription: fields.description.trim(),
        startExe: fields.startExe.trim(),
      });
    } finally {
      setSaving(false);
      onClose();
    }
  };

  return (
    <Dialog
      title="Make PortableApps.com Package"
      onClose={onClose}
      width={760}
      buttons={
        <>
          {!bugDismissed && (
            <button onClick={() => setBugDismissed(true)}>
              I understand – don't show this notice again
            </button>
          )}
          <button disabled={saving} onClick={generatePackage}>
            {saving ? 'Generating…' : 'Generate Package'}
          </button>
          <button className="primary" onClick={onClose}>
            Cancel
          </button>
        </>
      }
    >
      {!bugDismissed && (
        <div className="safe-note" style={{ border: '1px solid var(--red)', padding: '10px', marginBottom: '12px', background: 'var(--red-dim)' }}>
          <strong>⚠ Portable compiler is new – may have bugs.</strong>
          <br />
          The PortableApps.com package generator is recent and may make mistakes or produce
          packages that don't work perfectly. The developer is actively polishing it to
          mitigate issues. <strong>Always test the resulting portable package before relying on it.</strong>
        </div>
      )}
      <p className="heading">
        Create a PortableApps.com package from this program. Purgeon copies the program's
        files into a PortableApps.com folder structure and writes an NSIS installer script
        that you compile with makensis into a .paf.exe.
      </p>
      <div className="field-row">
        <label>Package name</label>
        <input
          value={fields.name}
          onChange={(e) => setFields({ ...fields, name: e.target.value })}
          placeholder="e.g. FooEditor"
          title="The program name shown in the PortableApps.com menu"
        />
      </div>
      <div className="field-row">
        <label>Version</label>
        <input
          value={fields.version}
          onChange={(e) => setFields({ ...fields, version: e.target.value })}
          placeholder="1.0.0"
        />
      </div>
      <div className="field-row">
        <label>Publisher (developer)</label>
        <input
          value={fields.publisher}
          onChange={(e) => setFields({ ...fields, publisher: e.target.value })}
          placeholder="e.g. Example Corp"
        />
      </div>
      <div className="field-row">
        <label>Homepage (optional)</label>
        <input
          value={fields.homepage}
          onChange={(e) => setFields({ ...fields, homepage: e.target.value })}
          placeholder="https://example.com"
        />
      </div>
      <div className="field-row">
        <label>Description (optional)</label>
        <input
          value={fields.description}
          onChange={(e) => setFields({ ...fields, description: e.target.value })}
          placeholder="Portable version of Foo Editor"
        />
      </div>
      <div className="field-row">
        <label>Main executable</label>
        <select
          value={fields.startExe}
          onChange={(e) => setFields({ ...fields, startExe: e.target.value })}
        >
          <option value="">(auto-detect)</option>
          {exes.map((exe) => (
            <option key={exe} value={path.basename(exe)}>
              {path.basename(exe)}
            </option>
          ))}
        </select>
        {exes.length === 0 && <span className="muted">No executable found in program files.</span>}
      </div>
      <p className="footnote">
        After generating, place a PortableApps.com launcher executable in the package folder
        and compile the .nsi script with NSIS (makensis) to produce the .paf.exe installer.
      </p>
    </Dialog>
  );
}

// Program detail pane: a read-only view of everything Purgeon knows about one program.
export function ProgramDetailDialog({ program, insight = {}, sizes = {}, onClose }) {
  const sig = insight?.signature || 'Unknown';
  const signer = insight?.signer || '';
  const days = insight?.lastUsed?.time
    ? Math.floor((Date.now() - new Date(insight.lastUsed.time).getTime()) / 86400000)
    : null;
  const progSizes = sizes?.[program.key] || {};
  const totalKB = program.sizeKB || progSizes.total || 0;
  return (
    <Dialog
      title={`Program – ${program.name}`}
      onClose={onClose}
      width={760}
      buttons={
        <>
          <button onClick={onClose}>Close</button>
        </>
      }
    >
      <p className="heading">
        <b>{program.name}</b>
        {program.version && ` (v${program.version})`}
        {program.publisher ? ` · ${program.publisher}` : ''}
      </p>
      <table className="detail-table">
        <tbody>
          <tr>
            <th>Type</th>
            <td>{program.store ? 'Windows Store app' : 'Desktop program'}</td>
          </tr>
          <tr>
            <th>Architecture</th>
            <td>
              {insight?.arch ? (ARCH_LABEL[insight.arch] || insight.arch) : program.arch === 'x86' ? '32-bit' : program.arch === 'x64' ? '64-bit' : 'Unknown'}
            </td>
          </tr>
          <tr>
            <th>Installed</th>
            <td>{program.date || 'Not recorded'}</td>
          </tr>
          <tr>
            <th>Location</th>
            <td className="path">{program.location || 'Not recorded'}</td>
          </tr>
          <tr>
            <th>Disk space</th>
            <td>{totalKB ? `${(totalKB / 1024).toFixed(1)} MB` : 'Not measured'}</td>
          </tr>
          <tr>
            <th>Uninstall entry</th>
            <td className="path">{program.key}</td>
          </tr>
          <tr title="Digital signature status of the program's main executable">
            <th>Signature</th>
            <td>
              {sig === 'Valid' ? `Valid — signed by ${signer || 'the publisher'}` : sig === 'NotSigned' ? 'Not digitally signed' : `Issue: ${sig}`}
            </td>
          </tr>
          {days !== null && (
            <tr>
              <th>Last used</th>
              <td>{days === 0 ? 'Today' : days === 1 ? 'Yesterday' : `${days} days ago`}</td>
            </tr>
          )}
          {insight?.offer && (
            <tr>
              <th>Bundled offer</th>
              <td>Its name matches programs often installed as bundled offers.</td>
            </tr>
          )}
          {insight?.together?.length && (
            <tr>
              <th>Installed with</th>
              <td>{insight.together.join(', ')}</td>
            </tr>
          )}
          {insight?.growth && (
            <tr>
              <th>Size trend</th>
              <td>Growing in size — may be accumulating data or logs.</td>
            </tr>
          )}
        </tbody>
      </table>
      <p className="footnote">
        This is a read-only view. To uninstall, force-remove, or scan for leftovers, use the
        action bar or right-click menu on the program list.
      </p>
    </Dialog>
  );
}

// Confirmation settings: lets the user re-enable confirmation prompts they previously disabled.
export function ConfirmationSettingsDialog({ settings, onSave, onClose }) {
  const [disabled, setDisabled] = useState(Array.isArray(settings.disabledConfirmations) ? [...settings.disabledConfirmations] : []);

  const allConfirmations = [
    { id: 'confirmUninstall', label: 'Uninstall a program' },
    { id: 'confirmForce', label: 'Force-remove a program' },
    { id: 'confirmBatchUninstall', label: 'Batch uninstall several programs' },
    { id: 'confirmBatchRemove', label: 'Batch remove leftover items' },
    { id: 'confirmMonitoredUninstall', label: 'Uninstall a monitored program' },
    { id: 'confirmRunUninstaller', label: "Run a monitored program's own uninstaller" },
    { id: 'confirmDebloat', label: 'Apply Windows debloat tweaks' },
    { id: 'confirmUpdate', label: 'Update programs via winget' },
    { id: 'confirmQueueUninstall', label: 'Uninstall programs from the queue' },
    { id: 'confirmRemovePortable', label: 'Remove a portable app' },
    { id: 'confirmSnapshotCleanup', label: 'Clean up snapshot differences' },
    { id: 'removeEntry', label: 'Remove a program from the list' },
    { id: 'orphanCleanup', label: 'Clean up orphaned leftovers' },
    { id: 'queueRestart', label: 'Restart after a queued uninstall' },
    { id: 'repairUninstaller', label: 'Repair a program via winget' },
    { id: 'getNewerSettings', label: 'Get newer settings from sync' },
    { id: 'bugReport', label: 'Send a bug report' },
    { id: 'deleteSnapshot', label: 'Delete a snapshot' },
    { id: 'undoChange', label: 'Undo a recorded change' },
    { id: 'reinstallArchive', label: 'Reinstall from the archive' },
    { id: 'putBackLeftovers', label: 'Put back removed leftovers' },
    { id: 'deleteFromArchive', label: 'Delete from the archive' },
    { id: 'restoreBackup', label: 'Restore a backup' },
    { id: 'deleteBackup', label: 'Delete a backup' },
    { id: 'removeFirewallRules', label: 'Remove firewall rules' },
    { id: 'keepTrial', label: 'Keep a trial program past expiry' },
    { id: 'turnOffCtxMenu', label: 'Turn off a context menu entry' },
    { id: 'uninstallUnsigned', label: 'Uninstall a program without a valid signature' },
    { id: 'forceUnsigned', label: 'Force-remove a program without a valid signature' },
    { id: 'closeRunningPrograms', label: 'Close running programs before removal' },
    { id: 'cleanJunk', label: 'Clean junk files' },
    { id: 'cleanSystemWindows', label: 'Run permanent Windows clean-up' },
  ];

  const isDisabled = (id) => disabled.includes(id);

  const toggle = (id) => {
    if (isDisabled(id)) setDisabled(disabled.filter((x) => x !== id));
    else setDisabled([...disabled, id]);
  };

  const restoreAll = () => setDisabled([]);

  const save = async () => {
    await onSave({ disabledConfirmations: disabled });
    onClose();
  };

  return (
    <Dialog
      title="Confirmation Prompts"
      onClose={onClose}
      width={700}
      buttons={
        <>
          <button onClick={restoreAll}>Restore All</button>
          <button className="primary" onClick={save}>Save</button>
          <button onClick={onClose}>Cancel</button>
        </>
      }
    >
      <p className="heading">
        Confirmations you disabled with "Don't show again" are listed below. Restore any you want
        to see again. Disabled confirmations are answered automatically (as if you clicked Yes)
        and a warning notice appears instead of the prompt.
      </p>
      <table>
        <thead>
          <tr>
            <th style={{ textAlign: 'left', width: '60%' }}>Confirmation</th>
            <th style={{ textAlign: 'left' }}>Status</th>
          </tr>
        </thead>
        <tbody>
          {allConfirmations.map((c) => (
            <tr key={c.id}>
              <td>{c.label}</td>
              <td>
                {isDisabled(c.id) ? (
                  <button onClick={() => toggle(c.id)}>Disabled · Restore</button>
                ) : (
                  <span style={{ color: 'var(--muted)' }}>Enabled</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="footnote">
        To disable a confirmation again, check "Don't show again" when it appears. Changes take
        effect immediately.
      </p>
    </Dialog>
  );
}
