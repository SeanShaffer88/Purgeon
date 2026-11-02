import { useRef } from 'react';
import { t, tx } from './backend/i18n.js';

export function ActionToolbar({ items, ready, dispatch, tips, shortLabel, barRef, compact }) {
  const menu = useRef(null);
  const primary = compact ? items.filter(([id]) => ['analyzeProgram', 'properties', 'uninstall'].includes(id)) : items;
  const extra = compact ? items.filter(([id]) => !['analyzeProgram', 'properties', 'uninstall'].includes(id)) : [];
  const label = (id, fallback) => { const key = ({ analyzeProgram: 'actionAnalyze', backupProgram: 'actionBackup', queueAdd: 'actionQueue', setGroup: 'actionGroup' })[id] || `action${id[0].toUpperCase()}${id.slice(1)}`; const value = t(key); return value === key ? tx(shortLabel(fallback)) : value; };
  const button = ([id, text]) => <button key={id} className={`action-button ${id === 'analyzeProgram' || id === 'properties' ? 'primary' : ''} ${/^(force|delete|uninstall)/i.test(id) ? 'danger' : ''}`} disabled={!ready(id)} onClick={() => { if (menu.current) menu.current.open = false; dispatch(id); }} title={tx(tips[id] || '')}>{label(id, text)}</button>;
  return <div className="action-bar simplified" role="toolbar" aria-label={t('actionsLabel')} ref={barRef}>
    {primary.map(button)}
    {extra.length > 0 && <details className="more-actions" ref={menu} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); menu.current.open = false; menu.current.querySelector('summary')?.focus(); } }}><summary>{t('moreActions')}</summary><div>{extra.map(button)}</div></details>}
  </div>;
}
