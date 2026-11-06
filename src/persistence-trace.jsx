import { useEffect, useRef, useState } from 'react';
import { Dialog } from './core-dialog.jsx';
import { tx } from './backend/i18n.js';

const api = window.api;
const unavailable = { status: 'unavailable', lookbackDays: 7, events: [] };
const statusText = {
  matches: 'Matching events were observed.',
  noMatch: 'No matching event was observed in the checked log.',
  disabled: 'This Windows event channel is disabled.',
  denied: 'Windows denied access to this event channel.',
  unsupported: 'This event channel or event format is unsupported.',
  partial: 'The search was incomplete. Any results shown are partial.',
  unavailable: 'The event log could not be checked.',
};
const actions = { created: 'Run value created', registered: 'Registered', updated: 'Updated', deleted: 'Deleted', disabled: 'Disabled' };

export function usePersistenceTrace() {
  const generation = useRef(0);
  const [view, setView] = useState(null);
  useEffect(() => () => { generation.current++; }, []);
  const close = () => {
    generation.current++;
    setView(null);
  };
  const open = async (kind, label, target) => {
    const serial = ++generation.current;
    setView({ kind, label, result: null });
    let result;
    try { result = await api.invoke(kind === 'run' ? 'startup:trace' : 'tasks:trace', target); }
    catch { result = unavailable; }
    if (serial === generation.current) setView({ kind, label, result });
  };
  return { view, open, close };
}

function Timestamp({ value }) {
  const date = new Date(value);
  return <time dateTime={date.toISOString()}>{date.toLocaleString()}</time>;
}

export function PersistenceTraceDialog({ view, onClose }) {
  const { kind, label, result } = view;
  const run = kind === 'run';
  return (
    <Dialog title={tx("Persistence Trace")} width={690} onClose={onClose}
      buttons={<button autoFocus onClick={onClose}>{tx("Close")}</button>}>
      <div className="persistence-trace">
        <h3>{label}</h3>
        <p>{tx(run ? "Source: Security event log · Registry audit 4657" : "Source: Task Scheduler Operational event log")}</p>
        <p className="muted">{tx("Checks the last seven days of available events. Logging and retention vary, so missing evidence does not establish that nothing happened.")}</p>
        <p className="muted">{tx(run
          ? "Writer details come from the event at the time it was recorded. These events do not show whether the startup entry is enabled now."
          : "Accounts come from the event payload. The creator process is unknown, and registration does not establish current enabled state.")}</p>
        {!result ? <p className="impact-note" role="status">{tx("Checking recorded events…")}</p> : (
          <>
            <p className="impact-note" role="status">{tx(statusText[result.status] || statusText.unavailable)}</p>
            {result.events.length > 0 && (
              <ul className="tree persistence-trace-events">
                {result.events.map((event) => (
                  <li key={event.recordId}>
                    <b>{tx(actions[event.action])}</b>
                    {' · '}<Timestamp value={event.atMs} />
                    {event.recordedDisableAtMs && <div className="muted">{tx("After matching saved disable entry · computer unverified")} · <Timestamp value={event.recordedDisableAtMs} /></div>}
                    {run ? (
                      <div className="muted">{tx("Event-time writer")} · {event.writerProcess || tx("Process not recorded")}{event.writerPid ? ' · ' + tx("PID {p0}", { p0: event.writerPid }) : ''}</div>
                    ) : <div className="muted">{tx("Event account")} · {event.account || tx("Account not recorded")}</div>}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
