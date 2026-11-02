import { tx, t } from './backend/i18n.js';
import { useEffect, useRef, useState } from 'react';
import { canRememberConfirmation, confirmationLabel } from './backend/confirmation-policy.js';
const api = window.api;

// Shared ownership prevents nested unmount order from leaving stale inert state.
const modalLayers = new Map();
const originalInert = new Map();
const focusableIn = (el) => [...el.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]')].filter((node) => node.getClientRects().length > 0 && !node.closest('[inert]'));
const topModal = () => [...document.querySelectorAll('.dialog, .palette')].filter((node) => modalLayers.has(node)).at(-1);
function updateModalIsolation() {
  for (const [node, value] of originalInert) node.inert = value;
  const top = topModal();
  if (!top) { originalInert.clear(); return; }
  let branch = top;
  while (branch.parentElement && branch.parentElement !== document.documentElement) {
    for (const sibling of branch.parentElement.children) {
      if (sibling === branch || ['SCRIPT', 'STYLE', 'LINK'].includes(sibling.tagName)) continue;
      if (!originalInert.has(sibling)) originalInert.set(sibling, sibling.inert);
      sibling.inert = true;
    }
    branch = branch.parentElement;
  }
}
export function useModalLayer(ref, onClose) {
  const close = useRef(onClose);
  close.current = onClose;
  const opener = useRef(typeof document === 'undefined' ? null : document.activeElement);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    modalLayers.set(el, true);
    updateModalIsolation();
    if (topModal() === el) (el.querySelector('[autofocus], [data-safe-default]') || el).focus();
    const onKey = (event) => {
      if (topModal() !== el || event.defaultPrevented) return;
      if (event.key === 'Escape' && close.current) { event.preventDefault(); event.stopPropagation(); close.current(); }
      if (event.key !== 'Tab') return;
      const items = focusableIn(el), first = items[0], last = items.at(-1);
      if (!first) { event.preventDefault(); el.focus(); }
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === el || !el.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !el.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    const onFocus = (event) => { if (topModal() === el && !el.contains(event.target)) (focusableIn(el)[0] || el).focus(); };
    window.addEventListener('keydown', onKey);
    document.addEventListener('focusin', onFocus);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('focusin', onFocus);
      modalLayers.delete(el);
      updateModalIsolation();
      queueMicrotask(() => {
        const top = topModal();
        const previous = opener.current;
        if (previous?.isConnected && !previous.closest('[inert]') && (!top || top.contains(previous))) previous.focus();
        else if (top) (focusableIn(top)[0] || top).focus();
      });
    };
  }, [ref]);
}

export function Dialog({ title, onClose, children, buttons, width = 520 }) {
  const dialogRef = useRef(null);
  useModalLayer(dialogRef, onClose);
  return (
    <div className="overlay">
      <div className="dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined} tabIndex="-1" style={{ width, maxWidth: '96vw' }}>
        <div className="dialog-title">
          <span>{typeof title === 'string' ? tx(title) : title}</span>
          {onClose && (
            <button className="title-close" onClick={onClose} aria-label={tx("Close")}>
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
  confirmId = canRememberConfirmation(confirmId) ? confirmId : null;
  const [checked, setChecked] = useState(!!checkboxChecked);
  const [dontShow, setDontShow] = useState(false);
  const handleAnswer = (ok) => {
    if (ok && confirmId && dontShow) {
      api.invoke('settings:get').then((s) => {
        const disabled = Array.isArray(s.disabledConfirmations) ? [...s.disabledConfirmations] : [];
        if (!disabled.includes(confirmId)) disabled.push(confirmId);
        return api.invoke('settings:set', { disabledConfirmations: disabled });
      }).catch(() => {});
    }
    onAnswer({ ok, checked, dontShow: ok && dontShow });
  };
  return (
    <Dialog
      title={tx("Purgeon")}
      onClose={() => handleAnswer(false)}
      width={500}
      buttons={
        <>
          <button onClick={() => handleAnswer(true)}>{tx(confirmationLabel(message))}</button>
          <button className="primary" data-safe-default autoFocus onClick={() => handleAnswer(false)}>{t('cancel')}</button>
        </>
      }
    >
      <p className="heading">{tx(message)}</p>
      {detail && <p className="confirm-detail">{tx(detail)}</p>}
      {checkboxLabel && (
        <label className="confirm-check">
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
          {checkboxLabel}
        </label>
      )}
      {confirmId && (
        <label className="confirm-check">
          <input type="checkbox" checked={dontShow} onChange={(e) => setDontShow(e.target.checked)} />
          {dontShowLabel || tx("Don't show again")}
        </label>
      )}
    </Dialog>
  );
}

export function Busy({ busy, message, onStop, onPause, onCancel }) {
  const busyRef = useRef(null);
  useModalLayer(busyRef);
  // Accept either a string message or a rich busy object.
  const msg = typeof busy === 'string' ? busy : busy?.message || message || '';
  const progress = typeof busy === 'object' ? busy.progress : null;
  const elapsed = typeof busy === 'object' ? busy.elapsed : null;
  const current = typeof busy === 'object' ? busy.current : null;
  const total = typeof busy === 'object' ? busy.total : null;
  const canPause = typeof busy === 'object' ? !!busy.canPause : false;
  const canCancel = typeof busy === 'object' ? !!busy.canCancel : false;

  const [stopping, setStopping] = useState(false);
  const [paused, setPaused] = useState(false);
  const startTime = useRef(Date.now());
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setElapsedSeconds(Math.floor((Date.now() - startTime.current) / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);

  const pct = progress != null ? progress : (current != null && total ? Math.round((current / total) * 100) : null);
  const displayElapsed = elapsed != null ? elapsed : elapsedSeconds;
  const timeText = displayElapsed > 0 ? ` (${displayElapsed}s)` : '';

  return (
    <div className="overlay">
      <div className="dialog busy" ref={busyRef} tabIndex={-1} role="dialog" aria-modal="true" style={{ width: 480 }} aria-live="polite" aria-label={t('busyLabel')}>
        <div className="dialog-body">
          <div className="busy-msg">{tx(msg)}{timeText}</div>
          {pct != null && (
            <>
              <div className="progress" role="progressbar" aria-label="Operation progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.max(0, Math.min(100, pct))}>
                <div className="progress-bar" style={{ width: `${pct}%` }} />
              </div>
              <div className="progress-text">
                {current != null && total ? t('progressFraction', { current, total }) : ''}
                {pct != null ? ` · ${pct}%` : ''}
              </div>
            </>
          )}
          {paused && <div className="busy-paused">{tx("Paused")}</div>}
        </div>
        <div className="dialog-buttons">
          {canPause && (
            <button
              disabled={stopping}
              onClick={() => {
                const next = !paused;
                setPaused(next);
                if (onPause) onPause(next);
              }}
            >
              {tx(paused ? 'Resume' : 'Pause')}
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
              {tx(stopping ? 'Stopping…' : canCancel ? 'Cancel' : 'Stop After This One')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
