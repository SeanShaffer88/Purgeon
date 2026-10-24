import { useState } from 'react';
import { Dialog } from './dialogs.jsx';

// Puts one or more programs in a group, or takes them out of their group.
export function GroupDialog({ programs, current, grouped, names, onSave, onClose }) {
  const [name, setName] = useState(current);
  const who = programs.length === 1 ? programs[0].name : `${programs.length} programs`;
  const save = () => name.trim() && onSave(name.trim());
  return (
    <Dialog
      title="Set Group"
      onClose={onClose}
      width={460}
      buttons={
        <>
          <button className="primary" disabled={!name.trim()} onClick={save}>
            Set Group
          </button>
          {grouped && <button onClick={() => onSave('')}>Remove from Group</button>}
          <button onClick={onClose}>Cancel</button>
        </>
      }
    >
      <p className="heading">Put {who} in a group. Use the group list in the toolbar to show one group at a time.</p>
      <label className="field">
        Group
        <input autoFocus list="group-names" maxLength={60} value={name} placeholder="e.g. Games, Work, Utilities" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
        <datalist id="group-names">
          {names.map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
      </label>
      {names.length > 0 && (
        <div className="group-chips">
          {names.map((n) => (
            <button key={n} className={`chip ${n === name ? 'on' : ''}`} onClick={() => setName(n)}>
              {n}
            </button>
          ))}
        </div>
      )}
    </Dialog>
  );
}
