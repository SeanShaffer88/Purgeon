import { useState } from 'react';
import { Dialog } from './dialogs.jsx';

const KIND = { dir: 'Folder', file: 'File', key: 'Registry key', value: 'Registry value' };
const label = (i) => (i.kind === 'value' ? `${i.path}  ›  ${i.name || '(default)'}` : i.path);
const formatBytes = (b) => (!b ? '' : b < 1048576 ? `${(b / 1024).toFixed(0)} KB` : b < 1073741824 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1073741824).toFixed(2)} GB`);

function Checklist({ items, chosen, setChosen, render, disabled = () => false }) {
  const toggle = (id) =>
    setChosen((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  return (
    <div className="tree transfer-list">
      {items.map((i) => (
        <label key={i.id} className={`tree-item ${disabled(i) ? 'info' : ''}`}>
          <input type="checkbox" disabled={disabled(i)} checked={chosen.has(i.id)} onChange={() => toggle(i.id)} />
          <span className={`kind kind-${i.kind}`} />
          {render(i)}
        </label>
      ))}
    </div>
  );
}

const MODES = [
  ['all', 'Program and my settings', 'Everything, to carry on where you left off on the other PC.'],
  ['program', 'Program only', 'A clean copy without your personal settings, history or sign-ins.'],
  ['settings', 'My settings only', 'For a PC where the program is already installed.'],
];

// Packages a program to move it to another PC (or keep as a backup): its folders, shortcuts and
// registry settings, with or without the user's own settings. `settings[n]` says whether item n
// is a user setting (see transfer.isSettings).
export function ProgramBackupDialog({ program, items, settings = [], onSave, onClose }) {
  const list = items.map((i, n) => ({ ...i, id: n, mine: !!settings[n] }));
  const [mode, setMode] = useState('all');
  const fits = (i) => mode === 'all' || (mode === 'settings') === i.mine;
  const [chosen, setChosen] = useState(() => new Set(list.filter((i) => (i.score ?? 80) >= 70).map((i) => i.id)));
  const picked = list.filter((i) => chosen.has(i.id) && fits(i));
  return (
    <Dialog
      title={`Migrate Program – ${program.name}`}
      onClose={onClose}
      width={780}
      buttons={
        <>
          <span className="button-hint">{picked.length} selected</span>
          <button className="primary" disabled={!picked.length} onClick={() => onSave(picked, mode)}>
            Save Package…
          </button>
          <button onClick={onClose}>Cancel</button>
        </>
      }
    >
      <p className="heading">Pack {program.name} into one file to install it on another PC with Tools › Restore a Program Backup, or to keep as a backup.</p>
      <div className="mode-row" role="radiogroup">
        {MODES.map(([id, title, hint]) => (
          <label key={id} className={`preset ${mode === id ? 'on' : ''}`}>
            <input type="radio" name="migrate-mode" checked={mode === id} onChange={() => setMode(id)} />
            <b>{title}</b>
            <span className="muted">{hint}</span>
          </label>
        ))}
      </div>
      <Checklist
        items={list}
        chosen={chosen}
        setChosen={setChosen}
        disabled={(i) => !fits(i)}
        render={(i) => (
          <>
            <span className="path">{label(i)}</span>
            <span className={`muted part ${i.mine ? 'mine' : ''}`}>{i.mine ? 'Your settings' : 'Program'} · {KIND[i.kind]}</span>
          </>
        )}
      />
      <p className="footnote">
        Nothing is changed on this PC. Services, scheduled tasks and drivers are not included; if the program needs them, run its installer on the other PC and then restore My settings only.
      </p>
    </Dialog>
  );
}

const INSTALLER_NOTE = {
  msi: 'It was installed by Windows Installer, which will not know about the restored copy: it runs, but to repair or update it later, run its installer. If it does not start, install it normally and restore My settings only.',
  wix: 'It was installed by a WiX setup bundle, which will not know about the restored copy: to repair or update it later, run its installer.',
  installshield: 'It was installed by InstallShield, which will not know about the restored copy: to repair or update it later, run its installer.',
};
const CONTENTS = { all: 'the program and its settings', program: 'the program only', settings: 'settings only' };
// Chooses what to restore from a program backup, showing where each item goes on this PC.
export function ProgramRestoreDialog({ backup, onRestore, onClose }) {
  const list = backup.items.map((i) => ({ ...i, id: i.n }));
  const [chosen, setChosen] = useState(() => new Set(list.filter((i) => !i.blocked).map((i) => i.id)));
  return (
    <Dialog
      title={`Restore Program – ${backup.program.name}`}
      onClose={onClose}
      width={800}
      buttons={
        <>
          <span className="button-hint">{chosen.size} selected</span>
          <button className="primary" disabled={!chosen.size} onClick={() => onRestore([...chosen])}>
            Restore
          </button>
          <button onClick={onClose}>Cancel</button>
        </>
      }
    >
      <p className="heading">
        {backup.program.name} {backup.program.version} · packaged {new Date(backup.created).toLocaleString()} on {backup.source.computer || 'another PC'}, with {CONTENTS[backup.program.contents || 'all']}. Paths in {backup.source.user}’s profile are restored into yours.
      </p>
      {INSTALLER_NOTE[backup.program.installer] && <div className="safe-note">{INSTALLER_NOTE[backup.program.installer]}</div>}
      <Checklist
        items={list}
        chosen={chosen}
        setChosen={setChosen}
        disabled={(i) => !!i.blocked}
        render={(i) => (
          <>
            <span className="path" title={i.target !== i.path ? `Backed up from ${i.path}` : undefined}>
              {label({ ...i, path: i.target })}
            </span>
            <span className="muted">{i.blocked || (i.kind === 'dir' ? `${i.files} files ${formatBytes(i.bytes)}` : KIND[i.kind])}</span>
          </>
        )}
      />
      <p className="footnote">Existing folders and files are never overwritten. Existing registry keys are saved before the backup is merged into them. You can undo the restore from Tools › Change History.</p>
    </Dialog>
  );
}
