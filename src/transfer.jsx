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

// Chooses what goes into a program backup: the program's folders, shortcuts and settings found by the scan.
export function ProgramBackupDialog({ program, items, onSave, onClose }) {
  const list = items.map((i, n) => ({ ...i, id: n }));
  const [chosen, setChosen] = useState(() => new Set(list.filter((i) => (i.score ?? 80) >= 70).map((i) => i.id)));
  return (
    <Dialog
      title={`Back Up Program – ${program.name}`}
      onClose={onClose}
      width={760}
      buttons={
        <>
          <span className="button-hint">{chosen.size} selected</span>
          <button className="primary" disabled={!chosen.size} onClick={() => onSave(list.filter((i) => chosen.has(i.id)))}>
            Save Backup…
          </button>
          <button onClick={onClose}>Cancel</button>
        </>
      }
    >
      <p className="heading">Pack {program.name}’s folders, shortcuts and registry settings into one file, to keep or to restore on another PC with Tools › Restore a Program Backup.</p>
      <Checklist
        items={list}
        chosen={chosen}
        setChosen={setChosen}
        render={(i) => (
          <>
            <span className="path">{label(i)}</span>
            <span className="muted">{KIND[i.kind]}</span>
          </>
        )}
      />
      <p className="footnote">Nothing is changed on this PC. Services, scheduled tasks and drivers are not included; if the program needs them, run its installer on the other PC first and then restore its settings.</p>
    </Dialog>
  );
}

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
        {backup.program.name} {backup.program.version} · backed up {new Date(backup.created).toLocaleString()} on {backup.source.computer || 'another PC'}. Paths in {backup.source.user}’s profile are restored into yours.
      </p>
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
