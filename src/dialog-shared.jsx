import { tx } from './backend/i18n.js';

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

// A dry run's results: what would happen to each selected item, with nothing changed.
export function PlanView({ results, onBack, onExport }) {
  const skipped = results.filter((r) => !r.ok);
  return (
    <div className="plan">
      <div className="plan-bar">
        <b>{tx("Dry run · nothing was changed.")}</b>
        <span className="muted">
          {results.length - skipped.length}{tx(" would be removed or put back")}{skipped.length ? tx(", {p0} would be skipped", { p0: (skipped.length) }) : ''}.
        </span>
        <span className="plan-actions">
          <button onClick={onExport}>{tx("Export Plan…")}</button>
          <button onClick={onBack}>{tx("Back to the List")}</button>
        </span>
      </div>
      <div className="tree">
        {[...skipped, ...results.filter((r) => r.ok)].slice(0, 800).map((r, i) => (
          <div key={i} className={`result ${r.ok ? 'ok' : 'fail'}`}>
            <span className="mark">{r.ok ? '→' : '–'}</span>
            <span className="path">{itemLabel(r)}</span>
            <span className="muted">{tx(r.detail)}</span>
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
