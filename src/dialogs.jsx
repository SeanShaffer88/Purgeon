import { useMemo, useState, useEffect } from 'react';
import { SettingHelp } from './onboarding.jsx';

const api = window.api;

export function Dialog({ title, onClose, children, buttons, width = 520 }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="overlay">
      <div className="dialog" role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined} style={{ width, maxWidth: '96vw' }}>
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
      <div className="dialog busy" style={{ width: 480 }}>
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

export function AboutDialog({ onClose }) {
  return (
    <Dialog title="About Purgeon" onClose={onClose} width={420} buttons={<button className="primary" onClick={onClose}>OK</button>}>
      <p className="heading">Purgeon {__APP_VERSION__}</p>
      {window.__sweepPortable && <p className="muted">Portable mode: settings, backups and snapshots are kept in the "Purgeon Data" folder next to the program.</p>}
      <p>Uninstalls programs, then hunts down the leftover files, registry keys, startup entries and services they leave behind.</p>
      <p>It also monitors installations, compares system snapshots, cleans junk files and manages startup programs. Every change is backed up first and can be undone.</p>
      <p className="muted">An independent project, not affiliated with any other uninstaller.</p>
    </Dialog>
  );
}

// Shown on start when a removal was cut off (a crash or power cut) partway through.
export function InterruptedDialog({ pending, onChoose }) {
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
      width={560}
      buttons={
        <>
          <button className="primary" disabled={!valid} onClick={() => onSave({ backupMaxDays: Number(days), backupMaxMB: Number(mb) })}>
            Save
          </button>
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
    </Dialog>
  );
}
