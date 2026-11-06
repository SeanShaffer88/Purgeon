import { useEffect, useMemo, useRef, useState } from 'react';
import { tx } from './backend/i18n.js';
import { readSavedCleanupPlan, reviewSavedCleanupPlan } from './backend/saved-cleanup-plans.js';
import { safeAllowed } from './dialog-shared.jsx';

export function useSavedPlanReview(items, owners, safeMode, check) {
  const scope = useMemo(() => ({ items, owners, safeMode }), [items, owners, safeMode]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const generation = useRef(0);
  const opener = useRef(null);
  const restoreFocus = useRef(false);
  const [state, setState] = useState(null);
  const active = state?.scope === scope ? state : null;
  useEffect(() => () => { generation.current++; }, []);
  useEffect(() => {
    if (!active && restoreFocus.current) {
      restoreFocus.current = false;
      opener.current?.focus();
    }
  }, [active]);

  const inspect = async (file) => {
    if (!file || !check) return;
    const serial = ++generation.current;
    const current = () => currentScope.current === scope && generation.current === serial;
    setState({ scope, status: 'loading' });
    try {
      const document = await readSavedCleanupPlan(file);
      if (!current()) return;
      const rows = await reviewSavedCleanupPlan(document, items, { isAllowed: (item) => safeAllowed(item, safeMode), check });
      if (current()) setState({ scope, status: 'ready', document, rows });
    } catch {
      if (current()) setState({ scope, status: 'failed' });
    }
  };

  const back = () => {
    generation.current++;
    restoreFocus.current = true;
    setState(null);
  };
  const close = () => { generation.current++; };
  return { active, opener, inspect, back, close };
}

const statusText = {
  unchanged: 'No observed change',
  changed: 'Changed',
  missing: 'Missing from current scan or no longer present',
  ambiguous: 'Ambiguous target',
  blocked: 'Blocked by current checks',
  unavailable: 'Current dry run unavailable for this target',
};
const targetName = (row) => row.name || (['value', 'setvalue'].includes(row.kind) ? tx('(default)') : '');

export function SavedPlanReview({ state }) {
  if (state.status === 'loading') return <p className="impact-note" role="status">{tx("Reading and checking the saved plan…")}</p>;
  if (state.status === 'failed') return <p className="impact-note" role="alert">{tx("Could not open this saved cleanup plan. Choose a valid Purgeon JSON plan up to 1 MiB.")}</p>;
  const { document, rows } = state;
  return (
    <section className="saved-plan" aria-label={tx("Saved Cleanup Plan")}>
      <h3>{document.title || tx("Saved Cleanup Plan")}</h3>
      <p className="muted">{tx("Saved")} <time dateTime={document.createdAt}>{new Date(document.createdAt).toLocaleString()}</time></p>
      <p className="muted">{tx("This comparison leaves the current selection unchanged. Matching rows describe observed results and do not establish identity.")}</p>
      {!rows.length ? <p>{tx("The saved plan contains no items.")}</p> : (
        <div className="tree">
          <table>
            <thead><tr><th scope="col">{tx("Saved target")}</th><th scope="col">{tx("Current scan and fresh dry run")}</th></tr></thead>
            <tbody>
              {rows.map(({ saved, current, status }, index) => (
                <tr key={index}>
                  <td>
                    {saved.group && <div className="muted">{saved.group}</div>}
                    <b>{saved.kind}</b> · {saved.path}{targetName(saved) && <> › {targetName(saved)}</>}
                    {saved.detail && <div className="muted">{saved.detail}</div>}
                  </td>
                  <td>
                    <b>{tx(statusText[status])}</b>
                    {current?.group && current.group !== saved.group && <div className="muted">{current.group}</div>}
                    {current?.detail && <div className="muted">{tx(current.detail)}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
