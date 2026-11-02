import { tx } from './backend/i18n.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog, useModalLayer } from './core-dialog.jsx';

export function CommandPalette({ commands, onRun, onClose }) {
  const layerRef = useRef(null);
  useModalLayer(layerRef, onClose);
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const ref = useRef(null);
  const fuzzyScore = (text, query) => {
    const t = text.toLowerCase();
    const q = query.toLowerCase();
    let ti = 0;
    let score = 0;
    let consecutive = 0;
    for (const ch of q) {
      const idx = t.indexOf(ch, ti);
      if (idx === -1) return 0;
      if (idx === ti) consecutive++;
      else consecutive = 0;
      score += 1 + consecutive;
      ti = idx + 1;
    }
    if (t.startsWith(q)) score *= 2;
    return score;
  };

  const shown = useMemo(() => {
    const localized = commands.map((command) => ({ ...command, text: tx(command.text), hint: tx(command.hint || '') }));
    if (!q) return localized.slice(0, 40);
    const query = q.toLowerCase();
    return localized
      .map((c) => {
        const score = fuzzyScore(c.text, q);
        return score > 0 ? { ...c, _score: score } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b._score - a._score || a.text.localeCompare(b.text))
      .slice(0, 40);
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
        <div className="palette" ref={layerRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={tx("Command palette")} onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          title={tx("Type part of a command or program name; Up and Down choose, Enter runs, Esc closes")}
          value={q}
          placeholder={tx("Type a command or a program name…")}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') (e.preventDefault(), setI((x) => Math.min(shown.length - 1, x + 1)));
            else if (e.key === 'ArrowUp') (e.preventDefault(), setI((x) => Math.max(0, x - 1)));
            else if (e.key === 'Enter' && shown[i]) onRun(shown[i]);
            else if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
          }}
        />
        <div className="palette-list" ref={ref} role="listbox">
          {shown.map((c, n) => (
            <button key={c.id} role="option" aria-selected={n === i} className={n === i ? 'on' : ''} onMouseEnter={() => setI(n)} onClick={() => onRun(c)}>
              <span>{c.text}</span>
              <span className="accel">{c.hint || ''}</span>
            </button>
          ))}
          {!shown.length && <div className="muted palette-empty">{tx("Nothing matches.")}</div>}
        </div>
      </div>
    </div>
  );
}

export function CloseDialog({ onAnswer }) {
  const [remember, setRemember] = useState(false);
  return (
    <Dialog
      title={tx("Close Purgeon?")}
      onClose={() => onAnswer(null, false)}
      width={540}
      buttons={
        <>
          <button className="primary" onClick={() => onAnswer('tray', remember)}>{tx("Minimize to Tray")}</button>
          <button onClick={() => onAnswer('exit', remember)}>{tx("Exit")}</button>
          <button onClick={() => onAnswer(null, false)}>{tx("Cancel")}</button>
        </>
      }
    >
      <p className="heading">{tx("Keep Purgeon running in the notification area (tray), or exit it completely?")}</p>
      <p className="muted">{tx("In the tray it keeps watching for installers and new startup entries. Left-click its icon to open it again; right-click it to exit.")}</p>
      <label className="check-row" title={tx("Don’t ask again. View › Close Button Asks brings this question back.")}>
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />{tx(" Remember my choice")}</label>
    </Dialog>
  );
}
