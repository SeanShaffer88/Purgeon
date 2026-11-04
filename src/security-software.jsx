import { useEffect, useMemo, useRef, useState } from 'react';
import { ConfirmDialog } from './core-dialog.jsx';
import { canRunSecurityProduct, isSecurityRunEligible, securitySoftwareStatus, createSecuritySoftwareController } from './security-software-controller.js';

export function SecuritySoftwareView({ filter = '', onError, onStatus, api = window.api }) {
  const [state, setState] = useState({ inventory: null, loading: true, busy: false, phase: '', message: '' });
  const [selected, setSelected] = useState(null);
  const [confirmation, setConfirmation] = useState(null);
  const controller = useRef(null);
  const pending = useRef(null);
  const callbacks = useRef({ onError, onStatus });
  callbacks.current = { onError, onStatus };
  useEffect(() => {
    const current = createSecuritySoftwareController({
      invoke: (...args) => api.invoke(...args),
      confirmReview: review => new Promise(resolve => { pending.current = resolve; setConfirmation({ review }); }),
      confirm: plan => new Promise(resolve => { pending.current = resolve; setConfirmation(plan); }),
      onChange: setState,
      onError: error => callbacks.current.onError(error),
    });
    controller.current = current;
    current.load();
    return () => { current.dispose(); pending.current?.(false); pending.current = null; };
  }, [api]);
  const products = state.inventory?.products || [];
  const visible = useMemo(() => products.filter(p => `${p.name} ${p.publisher} ${p.version}`.toLowerCase().includes(filter.toLowerCase())), [products, filter]);
  const reviews = state.inventory?.reviews || [];
  const product = products.find(p => p.id === selected);
  useEffect(() => { onStatus(securitySoftwareStatus(state, visible.length)); }, [state, visible.length, onStatus]);
  const run = p => controller.current?.run(p);
  const answer = accepted => { const resolve = pending.current; pending.current = null; setConfirmation(null); resolve?.(accepted); };
  return <section className="security-software" aria-label="Remove AV">
    <div className="security-toolbar">
      <button disabled={!isSecurityRunEligible(product, state)} onClick={() => run(product)}>Run vendor removal utility</button>
      <button disabled={state.busy || state.loading} onClick={() => { setSelected(null); controller.current.load(); }}>Refresh inventory</button>
      {state.busy && ['prepared', 'downloading', 'verifying'].includes(state.phase) && <button onClick={() => controller.current.cancel()}>Cancel operation</button>}
    </div>
    <p className="security-warning">Try the product’s normal uninstaller first. Vendor removal utilities can remove security protection and may require a restart. Purgeon cannot undo their changes.</p>
    {state.inventory && !state.inventory.complete && <div className="security-warning" role="status">Inventory is incomplete. Unavailable sources may hide installed products.</div>}
    {!!state.inventory?.sources?.length && <details className="security-sources"><summary>Inventory sources</summary><ul>{state.inventory.sources.map(source => <li key={source.id}>{source.id}: {source.status}{source.detail ? ` — ${source.detail}` : ''}</li>)}</ul></details>}
    <p className="security-sources">Security Center registrations can remain after removal. Inventory evidence does not prove that a product is installed or actively protecting this PC.</p>
    {!!reviews.length && <section className="security-warning" aria-label="Previous utility attempts">
      <h2>Previous utility attempts require review</h2>
      <p>Check that the previous vendor utility has finished or closed, including any elevation prompt. Purgeon cannot determine whether removal completed. All vendor utilities remain blocked until every previous attempt is acknowledged.</p>
      {reviews.map(review => <div key={review.reviewId}><p><strong>{review.toolId ?? 'Unknown vendor utility'}</strong>: {review.detail}{!review.canAcknowledge || review.state !== 'reviewRequired' ? ' Acknowledgment is unavailable for this recovery record; all vendor utilities remain blocked.' : ''}</p><button disabled={state.busy || !review.canAcknowledge || review.state !== 'reviewRequired'} onClick={() => controller.current.acknowledge(review)}>Acknowledge previous attempt</button></div>)}
    </section>}
    <div className="security-table-wrap" aria-busy={state.loading}>
      <table className="security-table"><thead><tr><th scope="col">Installed product</th><th scope="col">Publisher</th><th scope="col">Version</th><th scope="col">Utility availability</th></tr></thead>
        <tbody>{visible.map(p => <tr key={p.id} className={p.id === selected ? 'selected' : ''} onClick={() => setSelected(p.id)} onDoubleClick={() => run(p)}>
          <th scope="row"><button className="security-product" aria-pressed={p.id === selected} disabled={state.busy} onClick={() => setSelected(p.id)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); setSelected(p.id); run(p); } }}>{p.name}</button></th>
          <td>{p.publisher || 'Unknown'}</td><td>{p.version || 'Unknown'}</td><td>{p.builtIn ? 'Built into Windows' : canRunSecurityProduct(p) ? 'Vendor utility available' : p.category === 'instructionsOnly' || p.unsupportedReason?.startsWith('Instructions only:') ? 'Instructions only' : 'Unsupported'}</td>
        </tr>)}</tbody>
      </table>
      {state.loading ? <p className="list-empty" role="status">Reading installed security software…</p> : !state.inventory ? <p className="list-empty" role="status">Inventory could not be read. Refresh to try again.</p> : !visible.length && <p className="list-empty">{products.length ? 'No products match the current filter.' : state.inventory.complete ? 'No installed security products were reported.' : 'No products were reported by the available sources. This is not a complete inventory.'}</p>}
    </div>
    <div className="security-detail">
      <h2>{product?.name || 'Select a security product'}</h2>
      {product ? <><p>{product.builtIn ? 'Microsoft Defender is built into Windows and cannot be removed here.' : product.unsupportedReason || (canRunSecurityProduct(product) ? 'Purgeon will prepare the matched vendor utility for review before downloading or launching it.' : 'No verified removal utility is available for this product.')}</p><p>Inventory evidence: {product.sources?.join(', ') || 'Unknown'}</p>
        {product.helpUrl && <button onClick={() => api.invoke('open:url', product.helpUrl).catch(e => onError(e.message))}>Official vendor instructions</button>}</> : <p>Single-click or press Space to select. Double-click or press Enter on a product to review its vendor utility.</p>}
    </div>
    {state.reviewBlocked && !reviews.length && <p role="status">A previous utility attempt requires review. Refresh inventory to load its acknowledgment controls before running another utility.</p>}
    <p className="security-operation" role="status" aria-live="polite">{state.message || 'Nothing selected. No changes have been made.'}</p>
    {confirmation?.review ? <ConfirmDialog message="I reviewed the previous attempt and the utility is closed." detail="Acknowledgment does not establish removal success. A new launch requires a fresh plan and confirmation." onAnswer={result => answer(result.ok)} /> : confirmation && <ConfirmDialog message={`Run ${confirmation.toolName} for ${confirmation.productName}?`} detail={`This utility may remove security protection and require a restart. Purgeon cannot undo its changes. ${confirmation.recoveryLimits || ''}`} onAnswer={result => answer(result.ok)} />}
  </section>;
}
