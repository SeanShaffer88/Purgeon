// Activity report for a month: programs added and removed, space freed, startup changes,
// updates, clean-ups, and programs flagged by the insights, as a standalone HTML page.
import * as history from './history.js';
import * as archive from './archive.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmt = (b) => (b < 1048576 ? `${(b / 1024).toFixed(0)} KB` : b < 1073741824 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1073741824).toFixed(2)} GB`);

// `month` is "YYYY-MM". `programs` and `insight` are the current program list and its insights.
export async function monthly(month, programs = [], insight = {}) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('Choose a month like 2026-10.');
  const inMonth = (iso) => String(iso || '').slice(0, 7) === month;
  const h = (await history.list()).filter((e) => inMonth(e.time));
  const removed = (await archive.list()).filter((e) => inMonth(e.removed));
  const added = programs.filter((p) => String(p.installDate || '').slice(0, 7) === month);
  const freed = h.reduce((n, e) => n + [...String(e.detail || '').matchAll(/([\d.]+) (KB|MB|GB) freed/g)].reduce((m, x) => m + Number(x[1]) * { KB: 1024, MB: 1048576, GB: 1073741824 }[x[2]], 0), 0);
  const by = (types) => h.filter((e) => types.includes(e.type));
  const flagged = programs.filter((p) => insight[p.key] && (insight[p.key].offer || insight[p.key].together || (insight[p.key].signature && insight[p.key].signature !== 'Valid')));
  const section = (title, rows, cols) =>
    `<h2>${esc(title)} <small>(${rows.length})</small></h2>${rows.length ? `<table><tr>${cols.map(([c]) => `<th>${esc(c)}</th>`).join('')}</tr>${rows.map((r) => `<tr>${cols.map(([, f]) => `<td>${esc(f(r))}</td>`).join('')}</tr>`).join('')}</table>` : '<p class="none">None.</p>'}`;
  const when = (e) => new Date(e.time || e.removed).toLocaleString();
  const flags = (p) => {
    const i = insight[p.key];
    return [i.signature && i.signature !== 'Valid' ? 'unsigned' : '', i.offer ? 'possible bundled offer' : '', i.together ? `installed with ${i.together.join(', ')}` : ''].filter(Boolean).join('; ');
  };
  const title = new Date(`${month}-15`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  return `<!doctype html><meta charset="utf-8"><title>SweepUninstall report, ${esc(title)}</title>
<style>body{font:14px Segoe UI,sans-serif;margin:28px;max-width:1100px}h1{margin-bottom:4px}.sum{display:flex;gap:16px;flex-wrap:wrap;margin:16px 0}.sum div{border:1px solid #ddd;padding:10px 14px;border-radius:6px}.sum b{display:block;font-size:22px}table{border-collapse:collapse;width:100%;margin-bottom:8px}th,td{text-align:left;padding:4px 8px;border-bottom:1px solid #e5e5e5;vertical-align:top}th{background:#f4f4f4}.none{color:#888}small{color:#888;font-weight:normal}</style>
<h1>SweepUninstall report: ${esc(title)}</h1><p>Made ${esc(new Date().toLocaleString())}.</p>
<div class="sum"><div><b>${added.length}</b>programs installed</div><div><b>${removed.length}</b>programs removed</div><div><b>${fmt(freed)}</b>freed by clean-ups</div><div><b>${by(['Startup', 'Service']).length}</b>startup changes</div><div><b>${by(['Update']).length}</b>updates</div><div><b>${flagged.length}</b>programs flagged</div></div>
${section('Programs installed', added, [['Program', (p) => `${p.name} ${p.version || ''}`], ['Publisher', (p) => p.publisher], ['Date', (p) => p.installDate]])}
${section('Programs removed', removed, [['Program', (e) => `${e.name} ${e.version || ''}`], ['How', (e) => ({ uninstalled: 'Uninstalled', forced: 'Force removed', store: 'Store app', outside: 'Outside SweepUninstall' })[e.how] || e.how], ['When', when]])}
${section('Startup and service changes', by(['Startup', 'Service']), [['Change', (e) => e.title], ['When', when]])}
${section('Updates and installs', by(['Update', 'Install']), [['Change', (e) => e.title], ['When', when]])}
${section('Clean-ups and removals', by(['Removal', 'Clean-up', 'Maintenance', 'Restore']), [['Change', (e) => e.title], ['Details', (e) => e.detail], ['When', when]])}
${section('Programs flagged now', flagged, [['Program', (p) => p.name], ['Why', flags]])}`;
}
