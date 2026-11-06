import { tx } from './backend/i18n.js';
import { failureHint } from './backend/impact.js';
import { useId, useState } from 'react';

export const itemLabel = (i) =>
  i.kind === 'value'
    ? `${i.path}  ›  ${i.name}`
    : i.kind === 'service'
      ? `Service: ${i.path}`
      : i.kind === 'task'
        ? `Task: ${i.path}`
        : i.kind === 'firewall'
          ? `Firewall: ${i.name || i.path}`
          : i.kind === 'setvalue'
            ? `Put back: ${i.path}  ›  ${i.name || '(default)'}`
            : i.kind === 'createkey'
              ? `Recreate: ${i.path}`
              : i.path;

// Safe Mode uses internal evidence rules, not calibrated probability estimates.
export const safeAllowed = (it, safeMode) => !safeMode || ((typeof it.score === 'number' ? it.score : it.confidence === 'high' ? 80 : 40) >= 90 && !['service', 'task', 'firewall'].includes(it.kind));

function CleanupImpactView({ results, impact }) {
  const id = useId();
  const [selected, setSelected] = useState(0);
  const row = impact.items[selected];
  if (!row) return null;
  const references = [
    ['Installed application paths', row.applications, impact.sources.installed],
    ['Shared-file records', row.sharedFiles.map(({ name, users }) => tx("{p0} ({p1} registered users)", { p0: name, p1: users })), impact.sources.shared],
    ['Services', row.services, impact.sources.integration],
    ['Scheduled tasks', row.tasks, impact.sources.integration],
    ['Startup entries', row.startup, impact.sources.integration],
  ];
  return (
    <section className="cleanup-impact" aria-labelledby={id}>
      <h3 id={id}>{tx("Cleanup Impact Lab")}</h3>
      <p className="muted">{tx("References are limited to the inventory Purgeon could read. Removal runs its safety checks again.")}</p>
      {row.pathEvidence && impact.sources.integration === 'partial' && <p className="muted">{tx("Startup integration inventory is partial.")}</p>}
      <label className="cleanup-impact-picker">
        <span>{tx("Inspect item")}</span>
        <select value={selected} onChange={(event) => setSelected(Number(event.target.value))}>
          {impact.items.map((_, i) => <option key={i} value={i}>{itemLabel(results[i])}</option>)}
        </select>
      </label>
      <dl>
        <dt>{tx("Selection evidence")}</dt>
        <dd>{tx(results[selected].reason || results[selected].evidence || 'No selection evidence was recorded.')}</dd>
        {row.pathEvidence && references.map(([name, matches, status]) => [
          <dt key={name}>{tx(name)}</dt>,
          <dd key={name + '-matches'}>{status === 'unavailable' ? tx("Inventory unavailable") : matches.join(', ') || tx("No observed matches")}</dd>,
        ])}
        {!row.pathEvidence && <><dt>{tx("Path references")}</dt><dd>{tx("Path-reference checks do not apply to this item.")}</dd></>}
        <dt>{tx("Prospective recovery")}</dt>
        <dd>{tx(row.recovery)}</dd>
      </dl>
      {row.truncated && <p className="muted">{tx("Some matches for this item were omitted.")}</p>}
      {impact.truncated && <p className="muted">{tx("Impact details are shown for the first {p0} results.", { p0: impact.items.length })}</p>}
    </section>
  );
}

// A dry run's results: what would happen to each selected item, with nothing changed.
export function PlanView({ results, onBack, onExport, impact, onSave }) {
  const skipped = results.filter((r) => !r.ok);
  const [saveStatus, setSaveStatus] = useState('');
  const save = async () => {
    setSaveStatus('saving');
    try {
      setSaveStatus(await onSave() ? 'saved' : '');
    } catch {
      setSaveStatus('failed');
    }
  };
  return (
    <div className="plan">
      <div className="plan-bar">
        <b>{tx("Dry run · nothing was changed.")}</b>
        <span className="muted">
          {results.length - skipped.length}{tx(" would be removed or put back")}{skipped.length ? tx(", {p0} would be skipped", { p0: (skipped.length) }) : ''}.
        </span>
        <span className="plan-actions">
          {onSave && <button onClick={save} disabled={saveStatus === 'saving'}>{tx("Save Plan…")}</button>}
          <button onClick={onExport}>{tx(onSave ? "Export HTML…" : "Export Plan…")}</button>
          <button onClick={onBack}>{tx("Back to the List")}</button>
        </span>
      </div>
      {saveStatus === 'saving' && <p className="impact-note" role="status">{tx("Saving plan…")}</p>}
      {saveStatus === 'saved' && <p className="impact-note" role="status">{tx("Cleanup plan saved.")}</p>}
      {saveStatus === 'failed' && <p className="impact-note" role="alert">{tx("Could not save the cleanup plan.")}</p>}
      {impact && <CleanupImpactView results={results} impact={impact} />}
      <div className="tree">
        {[...skipped, ...results.filter((r) => r.ok)].slice(0, 800).map((r, i) => (
          <div key={i} className={`result ${r.ok ? 'ok' : 'fail'}`}>
            <span className="mark">{r.ok ? '→' : '–'}</span>
            <span className="path">{itemLabel(r)}</span>
            <span className="muted">
              {tx(r.detail)}
              {!r.ok && failureHint(r.detail) && <span className="hint"> · {failureHint(r.detail)}</span>}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function planHtml(title, results) {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  return `<!doctype html><meta charset="utf-8"><title>Dry run</title>
<style>body{font:13px Segoe UI,sans-serif;margin:24px}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:3px 8px;border-bottom:1px solid #ddd;vertical-align:top}th{background:#f3f3f3}.no{color:#a33}</style>
<h1>Dry run: ${esc(title)}</h1><p>Exported ${new Date().toLocaleString()}. Nothing was changed.</p>
<table><tr><th>Type</th><th>Item</th><th>What would happen</th></tr>${results.map((r) => `<tr class="${r.ok ? '' : 'no'}"><td>${esc(r.kind)}</td><td>${esc(itemLabel(r))}</td><td>${esc(r.detail)}</td></tr>`).join('')}</table>`;
}


export const signatureText = (i) =>
  !i?.signature ? '' : i.signature === 'Valid' ? `Signed by ${i.signer || 'a trusted publisher'}` : i.signature === 'NotSigned' ? 'Not signed' : `Signature problem: ${i.signature}${i.signer ? ` (${i.signer})` : ''}`;

export const ARCH_LABEL = { x64: '64-bit (x64)', x86: '32-bit (x86)', arm64: 'ARM64', arm: 'ARM (32-bit)' };
