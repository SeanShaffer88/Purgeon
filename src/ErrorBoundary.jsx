import { Component } from 'react';

// Last-resort screen: if anything in the window throws while drawing, show the error
// in plain words instead of leaving an empty black window that cannot be closed.
// The native side only intercepts the close button once the page has loaded, so
// this screen can always be closed.
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    // The command log is the app's black box: leave the failure there for diagnosis.
    console.error(error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const message = this.state.error?.message || String(this.state.error);
    return (
      <div style={{ padding: '48px 40px', color: '#e8e8e8', fontFamily: 'Segoe UI, system-ui, sans-serif', maxWidth: 640 }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, margin: '0 0 12px' }}>Purgeon hit a problem drawing its window</h1>
        <p style={{ lineHeight: 1.55, margin: '0 0 10px' }}>
          The program itself is still running underneath, but the window could not be drawn. The error was:
        </p>
        <p style={{ background: '#1c1c1c', border: '1px solid #333', borderRadius: 6, padding: '10px 12px', fontFamily: 'Consolas, monospace', fontSize: 13, wordBreak: 'break-word' }}>{message}</p>
        <p style={{ lineHeight: 1.55 }}>
          You can close this window normally. If the problem comes back, the command log in Purgeon&apos;s data folder
          (a file named by date, in the logs folder) shows what the program was doing.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{ marginTop: 8, background: '#2b2b2b', color: '#e8e8e8', border: '1px solid #444', borderRadius: 6, padding: '8px 16px', cursor: 'pointer' }}
        >
          Reload the window
        </button>
      </div>
    );
  }
}
