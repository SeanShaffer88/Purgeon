import { Component, Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { tx } from './backend/i18n.js';
import { Dialog } from './core-dialog.jsx';

class ModalErrorBoundary extends Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  render() { return this.state.error ? this.props.fallback : this.props.children; }
}

export function optionalDialog(importer, name) {
  return function OptionalDialog(props) {
    const [attempt, setAttempt] = useState(0);
    const Loaded = useMemo(() => lazy(() => importer().then((module) => {
      if (typeof module[name] !== 'function') throw new Error('Requested window is unavailable');
      return { default: module[name] };
    })), [attempt]);
    const opener = useRef(typeof document === 'undefined' ? null : document.activeElement);
    useEffect(() => () => { queueMicrotask(() => { const node = opener.current; if (node?.isConnected && !node.closest('[inert]')) node.focus(); }); }, []);
    const close = props.onClose || (() => props.onChoose?.('dismiss'));
    const closeButton = <button autoFocus data-safe-default onClick={close}>{tx('Close')}</button>;
    const fallback = <Dialog title={tx('Loading…')} onClose={close} buttons={closeButton}><p role="status">{tx('Loading this window…')}</p></Dialog>;
    const error = <Dialog title={tx('Window Could Not Load')} onClose={close} buttons={<><button onClick={() => setAttempt((value) => value + 1)}>{tx('Try Again')}</button>{closeButton}</>}><div role="alert"><p>{tx('This window could not load. Your program list is still available.')}</p><p>{tx('Close this window or try loading it again.')}</p></div></Dialog>;
    return <ModalErrorBoundary key={attempt} fallback={error}><Suspense fallback={fallback}><Loaded {...props} /></Suspense></ModalErrorBoundary>;
  };
}
