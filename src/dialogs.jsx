import { useMemo, useState, useEffect } from 'react';

const api = window.api;

export function Dialog({ title, onClose, children, buttons, width = 520 }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="overlay">
      <div className="dialog" style={{ width }}>
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
export function ConfirmDialog({ message, detail, checkboxLabel, checkboxChecked, onAnswer }) {
  const [checked, setChecked] = useState(!!checkboxChecked);
  return (
    <Dialog
      title="SweepUninstall"
      onClose={() => onAnswer({ ok: false, checked })}
      width={500}
      buttons={
        <>
          <button className="primary" autoFocus onClick={() => onAnswer({ ok: true, checked })}>
            Yes
          </button>
          <button onClick={() => onAnswer({ ok: false, checked })}>No</button>
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
    </Dialog>
  );
}

export function Busy({ message, onStop }) {
  const [stopping, setStopping] = useState(false);
  return (
    <div className="overlay">
      <div className="dialog busy" style={{ width: 400 }}>
        <div className="dialog-body">
          <div className="busy-msg">{message}</div>
          <div className="progress">
            <div className="progress-bar" />
          </div>
        </div>
        {onStop && (
          <div className="dialog-buttons">
            <button
              disabled={stopping}
              onClick={() => {
                setStopping(true);
                onStop();
              }}
            >
              {stopping ? 'Stopping after this one…' : 'Stop After This One'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

const GROUPS = [
  { id: 'registry', label: 'Registry', kinds: ['key', 'value'] },
  { id: 'files', label: 'Files and Folders', kinds: ['dir', 'file'] },
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
          : i.path;

export function LeftoversDialog({ title, heading, items, onClose, onRemove }) {
  const [checked, setChecked] = useState(() => new Set(items.map((it, idx) => (it.confidence === 'high' ? idx : -1)).filter((i) => i >= 0)));
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
      return n;
    });

  return (
    <Dialog
      title={title}
      onClose={onClose}
      width={680}
      buttons={
        <>
          <span className="button-hint">{checked.size} of {items.length} selected</span>
          <button onClick={() => setChecked(new Set(items.map((_, i) => i)))}>Select All</button>
          <button onClick={() => setChecked(new Set())}>Select None</button>
          <button className="primary" disabled={!checked.size} onClick={() => onRemove(items.filter((_, i) => checked.has(i)))}>
            Delete Selected
          </button>
          <button onClick={onClose}>Close</button>
        </>
      }
    >
      <p className="heading">{heading}</p>
      {items.length === 0 ? (
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
                    <label key={idx} className={`tree-item ${it.confidence === 'low' ? 'low' : ''}`} title={`${it.reason}${typeof it.score === 'number' ? ` · match ${it.score}%` : ''}`}>
                      <input type="checkbox" checked={checked.has(idx)} onChange={() => toggle(idx)} />
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
      <p className="footnote">Everything you delete is backed up first. Registry entries can be restored from View › Backups, and files go to the Recycle Bin.</p>
    </Dialog>
  );
}

export function ResultsDialog({ title, results, note, onClose }) {
  const failed = results.filter((r) => !r.ok);
  return (
    <Dialog title={title} onClose={onClose} width={640} buttons={<button className="primary" onClick={onClose}>OK</button>}>
      <p className="heading">
        {failed.length ? `${results.length - failed.length} of ${results.length} items done, ${failed.length} failed.` : `All ${results.length} items done.`}
      </p>
      <div className="tree">
        {results.map((r, i) => (
          <div key={i} className={`result ${r.ok ? 'ok' : 'fail'}`}>
            <span className="mark">{r.ok ? '✓' : '✗'}</span>
            <span className="path">{itemLabel(r)}</span>
            <span className="muted">{r.detail}</span>
          </div>
        ))}
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
                  <input readOnly value={String(v)} onFocus={(e) => e.target.select()} />
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

// Tools › Monitor an Installation: before snapshot → user installs → after snapshot → diff.
export function MonitorWizard({ resume, onClose, onRecorded }) {
  const [step, setStep] = useState(resume ? 'installing' : 'pick');
  const [installer, setInstaller] = useState(resume?.installer || '');
  const [name, setName] = useState(() => (resume?.installer ? baseName(resume.installer) : ''));
  const [error, setError] = useState('');

  const begin = async () => {
    setError('');
    setStep('before');
    try {
      await api.invoke('monitor:start', installer || null);
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
          <p className="heading">SweepUninstall records every folder, file and registry key that an installer creates, so the program can be removed completely later.</p>
          <ol className="steps">
            <li>Close other programs so their changes aren't recorded.</li>
            <li>Choose the installer. SweepUninstall takes a snapshot and then starts it.</li>
            <li>When setup is done, come back and click <b>Installation Finished</b>.</li>
          </ol>
          <div className="field-row">
            <input readOnly value={installer} placeholder="No installer chosen" />
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
          {installer && <p className="muted">Installer: {installer}</p>}
          <label className="field">
            Name for this program
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Foo Editor" />
          </label>
        </>
      )}
    </Dialog>
  );
}

const baseName = (p) => (p || '').split('\\').pop().replace(/\.(exe|msi|msix|bat|cmd)$/i, '').replace(/[-_.]?(setup|installer|install|x64|x86|win64|win32)\b/gi, '').replace(/[-_]+/g, ' ').trim();

export function AboutDialog({ onClose }) {
  return (
    <Dialog title="About SweepUninstall" onClose={onClose} width={420} buttons={<button className="primary" onClick={onClose}>OK</button>}>
      <p className="heading">SweepUninstall 0.1</p>
      <p>Uninstalls programs, then hunts down the leftover files, registry keys, startup entries and services they leave behind.</p>
      <p>You can monitor installations to record exactly what they change, and every removal is backed up first.</p>
      <p className="muted">An independent project, not affiliated with the makers of Total Uninstall or Geek Uninstaller.</p>
    </Dialog>
  );
}
