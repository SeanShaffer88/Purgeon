import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AboutDialog, Busy, ConfirmDialog, LeftoversDialog, MonitorWizard, PropertiesDialog, ResultsDialog } from './dialogs.jsx';
import { setConfirmUI } from './backend/api.js';
import { DebloatView } from './debloat.jsx';
import { StartupView } from './startup.jsx';

const api = window.api;

const VIEWS = {
  desktop: { label: 'Desktop Programs', noun: 'programs', cols: [['name', 'Name'], ['size', 'Size'], ['date', 'Installed On']] },
  store: { label: 'Windows Store Apps', noun: 'apps', cols: [['name', 'Name'], ['version', 'Version'], ['publisher', 'Publisher']] },
  monitored: { label: 'Monitored Programs', noun: 'monitored programs', cols: [['name', 'Name'], ['size', 'Changes'], ['date', 'Monitored On']] },
  backups: { label: 'Backups', noun: 'backups', cols: [['name', 'Removed'], ['size', 'Entries'], ['date', 'Backed Up On']] },
  startup: { label: 'Startup & Services', noun: 'entries', cols: [], custom: true },
  // Reached through its own toolbar button, not the view picker.
  debloat: { label: 'Debloat Windows', noun: 'tweaks', cols: [], button: true, custom: true },
};

const formatSize = (kb) => {
  if (!kb) return '';
  if (kb < 1024) return `${kb} KB`;
  if (kb < 1024 * 1024) return `${(kb / 1024).toFixed(1)} MB`;
  return `${(kb / 1024 / 1024).toFixed(2)} GB`;
};

const normKey = (k) => (k || '').replace(/^HKEY_LOCAL_MACHINE\\/i, 'HKLM\\').replace(/^HKEY_CURRENT_USER\\/i, 'HKCU\\').toLowerCase();

// Shape every view's records into one row type for the list.
function toRow(view, r) {
  if (view === 'monitored') return { ...r, key: r.id, sizeText: `${r.items.length} items`, sortSize: r.items.length, date: r.finished.slice(0, 10) };
  if (view === 'backups') return { ...r, key: r.id, name: r.title, sizeText: `${r.entries.length}`, sortSize: r.entries.length, date: r.created.slice(0, 10) };
  return { ...r, sizeText: formatSize(r.sizeKB), sortSize: r.sizeKB || 0, date: r.installDate };
}

// The menu bar. The shortcuts shown here are handled by the keydown listener in App.
const MENUS = [
  ['File', [['export', 'Export to HTML...', 'Ctrl+S'], null, ['elevate', 'Restart as Administrator'], null, ['quit', 'Exit']]],
  [
    'Action',
    [
      ['uninstall', 'Uninstall...', 'Del'],
      ['force', 'Force Removal...', 'Shift+Del'],
      ['analyze', 'Analyze Leftovers...', 'Ctrl+L'],
      ['removeEntry', 'Remove Entry...'],
      null,
      ['registry', 'Registry Entry'],
      ['folder', 'Installation Folder'],
      ['search', 'Search Online'],
      null,
      ['properties', 'Properties', 'Alt+Enter'],
    ],
  ],
  [
    'View',
    [
      ['view:desktop', 'Desktop Programs', 'Ctrl+1'],
      ['view:store', 'Windows Store Apps', 'Ctrl+2'],
      ['view:monitored', 'Monitored Programs', 'Ctrl+3'],
      ['view:backups', 'Backups', 'Ctrl+4'],
      ['view:debloat', 'Debloat Windows', 'Ctrl+5'],
      ['view:startup', 'Startup & Services', 'Ctrl+6'],
      null,
      ['find', 'Find...', 'Ctrl+F'],
      ['refresh', 'Refresh', 'F5'],
    ],
  ],
  ['Tools', [['monitor', 'Monitor an Installation...', 'Ctrl+M'], null, ['toggleRestore', 'Create Restore Points']]],
  ['Help', [['about', 'About']]],
];

function MenuBar({ onAction, checked = {} }) {
  const [open, setOpen] = useState(null);
  useEffect(() => {
    if (open === null) return;
    const close = () => setOpen(null);
    window.addEventListener('mousedown', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('blur', close);
    };
  }, [open]);
  return (
    <div className="menubar" onMouseDown={(e) => e.stopPropagation()}>
      {MENUS.map(([label, entries], i) => (
        <div key={label} className="menubar-item">
          <button className={open === i ? 'open' : ''} onClick={() => setOpen(open === i ? null : i)} onMouseEnter={() => open !== null && setOpen(i)}>
            {label}
          </button>
          {open === i && (
            <div className="context-menu dropdown">
              {entries.map((it, j) =>
                it ? (
                  <button
                    key={j}
                    onClick={() => {
                      setOpen(null);
                      onAction(it[0]);
                    }}
                  >
                    <span>
                      {it[0] in checked && <span className="check">{checked[it[0]] ? '✓' : ''}</span>}
                      {it[1]}
                    </span>
                    <span className="accel">{it[2]}</span>
                  </button>
                ) : (
                  <div key={j} className="sep" />
                )
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export default function App() {
  const [view, setView] = useState('desktop');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState({ col: 'name', dir: 1 });
  const [selected, setSelected] = useState(null);
  const [icons, setIcons] = useState({});
  const [admin, setAdmin] = useState(null);
  const [modal, setModal] = useState(null);
  const [busy, setBusy] = useState('');
  const [menu, setMenu] = useState(null);
  // Multi-selection (keys); `selected` is the focused row and the range anchor moves with plain clicks.
  const [marked, setMarked] = useState(() => new Set());
  const anchor = useRef(null);
  const [busyStop, setBusyStop] = useState(null);
  const stopBatch = useRef(false);
  const [notice, setNotice] = useState(null);
  const [restoreOn, setRestoreOn] = useState(true);
  const debloatGatePassed = useRef(false);
  const searchRef = useRef(null);
  const listRef = useRef(null);
  const desktopCache = useRef([]);
  const lastListView = useRef('desktop');
  // Debloat and Startup views load their own data; their status text and remount key live here.
  const [customStatus, setCustomStatus] = useState('');
  const [customKey, setCustomKey] = useState(0);
  if (view !== 'debloat') lastListView.current = view;

  const load = useCallback(async (v = view) => {
    if (VIEWS[v].custom) return setCustomKey((k) => k + 1);
    setLoading(true);
    setError('');
    try {
      let data;
      if (v === 'monitored') data = await api.invoke('monitor:list');
      else if (v === 'backups') data = await api.invoke('backups:list');
      else data = await api.invoke('programs:list', v);
      if (v === 'desktop') {
        desktopCache.current = data;
        api.invoke('programs:measure', data).catch(() => {});
      }
      setRows(data.map((r) => toRow(v, r)));
    } catch (e) {
      setError(e.message);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [view]);

  useEffect(() => {
    setSelected(null);
    setMarked(new Set());
    anchor.current = null;
    if (!VIEWS[view].custom) load(view);
    else setCustomStatus('');
    // The Startup view names the program each entry belongs to, so it needs the program list.
    if (view === 'startup' && !desktopCache.current.length) api.invoke('programs:list', 'desktop').then((d) => (desktopCache.current = d)).catch(() => {});
  }, [view]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    api.invoke('app:isAdmin').then(setAdmin);
    api.invoke('settings:get').then((s) => setRestoreOn(s.createRestorePoints));
    api.invoke('monitor:status').then((s) => s && setModal({ type: 'monitor', resume: s }));
  }, []);

  // Icons arrive in one batch after the list is shown; programs without one keep a placeholder.
  useEffect(() => {
    if (view !== 'desktop') return;
    let cancelled = false;
    const missing = rows.filter((r) => !(r.key in icons));
    if (!missing.length) return;
    api
      .invoke('icons:get', missing)
      .then((found) => {
        if (!cancelled) setIcons((m) => ({ ...m, ...Object.fromEntries(missing.map((r) => [r.key, found[r.key] || null])) }));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = q ? rows.filter((r) => `${r.name} ${r.publisher || ''}`.toLowerCase().includes(q)) : rows;
    const val = (r) => (sort.col === 'size' ? r.sortSize : (r[sort.col] || '').toString().toLowerCase());
    return [...list].sort((a, b) => {
      const x = val(a);
      const y = val(b);
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
    });
  }, [rows, filter, sort]);

  const current = visible.find((r) => r.key === selected) || null;
  const markedRows = visible.filter((r) => marked.has(r.key));
  const batchable = view === 'desktop' || view === 'store';
  const isBatch = batchable && markedRows.length > 1;

  // ---- selection -----------------------------------------------------------

  const selectRow = (key, { ctrl = false, shift = false } = {}) => {
    const keys = visible.map((r) => r.key);
    if (shift && anchor.current && keys.includes(anchor.current)) {
      const [a, b] = [keys.indexOf(anchor.current), keys.indexOf(key)].sort((x, y) => x - y);
      setMarked(new Set(keys.slice(a, b + 1)));
    } else if (ctrl) {
      setMarked((m) => {
        const n = new Set(m);
        n.has(key) ? n.delete(key) : n.add(key);
        return n;
      });
      anchor.current = key;
    } else {
      setMarked(new Set([key]));
      anchor.current = key;
    }
    setSelected(key);
  };

  // ---- restore points ------------------------------------------------------

  const confirmWithRestore = (message, detail) =>
    api.invoke('dialog:confirm', { message, detail, checkboxLabel: 'Create a restore point first', checkboxChecked: restoreOn });

  const makeRestorePoint = async (description, kind) => {
    setBusy('Creating a restore point…\nThis can take a minute.');
    try {
      const r = await api.invoke('restore:create', { description, kind });
      setNotice(r.created ? { tone: 'ok', text: `Restore point created: "${description}".` } : { tone: 'warn', text: `${r.reason} Continuing without one.` });
    } catch (e) {
      setNotice({ tone: 'warn', text: `No restore point was made: ${e.message} Continuing without one.` });
    } finally {
      setBusy('');
    }
  };

  // Called by the Debloat view before a change; asks once per session.
  const beforeDebloatChange = async (title) => {
    if (debloatGatePassed.current || !restoreOn) return true;
    const r = await confirmWithRestore('Change Windows settings?', `SweepUninstall will apply "${title}". This question appears only before your first debloat change of this session.`);
    if (!r.ok) return false;
    if (r.checked) await makeRestorePoint('SweepUninstall: before Windows debloat changes', 'settings');
    debloatGatePassed.current = true;
    return true;
  };

  // ---- actions -------------------------------------------------------------

  const removeWithBackup = async (title, items, location) => {
    setModal(null);
    const locations = [].concat(location || []).filter(Boolean);
    if (locations.length) {
      const procs = (await Promise.all(locations.map((l) => api.invoke('program:processes', l).catch(() => [])))).flat();
      if (procs.length) {
        const ok = await api.invoke('dialog:confirm', {
          message: 'Close running programs?',
          detail: `These are running from the install folder and would block deletion:\n\n${procs.map((p) => p.ProcessName).join('\n')}`,
        });
        if (ok) await api.invoke('program:killProcesses', procs.map((p) => p.Id));
      }
    }
    setBusy('Backing up and removing selected items…');
    try {
      const { results } = await api.invoke('items:remove', { title, items });
      setModal({ type: 'results', title: 'Removal Report', results, note: 'A backup was saved. To undo, go to View › Backups.' });
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    } finally {
      setBusy('');
      load();
    }
  };

  const showLeftovers = (p, title, heading, items) =>
    setModal({
      type: 'leftovers',
      title,
      heading,
      items,
      onRemove: (sel) => removeWithBackup(p.name, sel, p.location),
    });

  const scanFor = async (p, title, headingFn) => {
    setBusy(`Scanning for leftovers of ${p.name}…`);
    try {
      const items = await api.invoke('program:scan', p);
      showLeftovers(p, title, headingFn(items), items);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  };

  const uninstallMonitored = async (rec) => {
    const keys = new Set(rec.uninstallKeys.map(normKey));
    const registered = desktopCache.current.find((p) => keys.has(normKey(p.key)));
    const run = registered && (await confirmWithRestore(`Run ${registered.name}'s own uninstaller first?`, 'Recommended. Afterwards SweepUninstall removes everything else the installation created.'));
    if (run?.ok) {
      if (run.checked) await makeRestorePoint(`SweepUninstall: before uninstalling ${registered.name}`, 'uninstall');
      setBusy(`Running the uninstaller for ${registered.name}…`);
      await api.invoke('program:runUninstaller', registered);
      setBusy('');
    }
    setModal({
      type: 'leftovers',
      title: `Uninstall – ${rec.name}`,
      heading: `This installation created ${rec.items.length} items. Items already removed are skipped.`,
      items: rec.items,
      onRemove: async (sel) => {
        if (await removeWithBackup(rec.name, sel)) {
          await api.invoke('monitor:remove', rec.id);
          load();
        }
      },
    });
  };

  // Runs each program's own uninstaller in turn, then shows one combined leftover list.
  const batchUninstall = async (list) => {
    const go = await confirmWithRestore(
      `Uninstall ${list.length} programs?`,
      `${list.map((p) => `• ${p.name}`).join('\n')}\n\nEach program's own uninstaller runs in turn, so finish each uninstaller's window. Afterwards SweepUninstall scans all of them for leftovers.`
    );
    if (!go.ok) return;
    if (go.checked) await makeRestorePoint(`SweepUninstall: before uninstalling ${list.length} programs`, 'uninstall');

    stopBatch.current = false;
    setBusyStop(() => () => {
      stopBatch.current = true;
    });
    const outcomes = [];
    for (const [i, p] of list.entries()) {
      if (stopBatch.current) {
        outcomes.push({ p, skipped: true });
        continue;
      }
      setBusy(`Uninstalling ${i + 1} of ${list.length}: ${p.name}…\nFinish the uninstaller's window if one appears.`);
      try {
        outcomes.push({ p, result: await api.invoke('program:runUninstaller', p) });
      } catch (e) {
        outcomes.push({ p, result: { ok: false, error: e.message } });
      }
    }
    setBusyStop(null);

    const ran = outcomes.filter((o) => !o.skipped && !o.p.store);
    const items = [];
    for (const [i, { p }] of ran.entries()) {
      setBusy(`Scanning for leftovers (${i + 1} of ${ran.length}): ${p.name}…`);
      const found = await api.invoke('program:scan', p).catch(() => []);
      items.push(...found.map((it) => ({ ...it, program: p.name })));
    }
    setBusy('');
    load();

    const ok = outcomes.filter((o) => o.result?.ok).length;
    const problems = outcomes
      .filter((o) => !o.result?.ok)
      .map((o) => (o.skipped ? `${o.p.name}: skipped` : o.result.error ? `${o.p.name}: ${o.result.error}` : `${o.p.name}: uninstaller exited with code ${o.result.code}`));
    const heading = `Uninstalled ${ok} of ${list.length} programs.${problems.length ? ` ${problems.join('; ')}.` : ''} SweepUninstall found ${items.length} leftover items.`;
    setModal({
      type: 'leftovers',
      title: `Batch Uninstall – ${list.length} programs`,
      heading,
      items,
      onRemove: (sel) => removeWithBackup(`Batch uninstall (${list.length} programs)`, sel, ran.map((o) => o.p.location)),
    });
  };

  const actions = {
    uninstall: async (p) => {
      if (view === 'monitored') return uninstallMonitored(p);
      if (view === 'backups') return actions.deleteBackup(p);
      const go = await confirmWithRestore(`Uninstall ${p.name}?`, p.store ? 'The app package will be removed.' : "The program's own uninstaller will run first, then SweepUninstall scans for leftovers.");
      if (!go.ok) return;
      if (go.checked) await makeRestorePoint(`SweepUninstall: before uninstalling ${p.name}`, 'uninstall');
      setBusy(`Running the uninstaller for ${p.name}…\nFinish the uninstaller's window if one appears.`);
      let result;
      try {
        result = await api.invoke('program:runUninstaller', p);
      } catch (e) {
        result = { ok: false, error: e.message };
      }
      setBusy('');
      if (p.store) {
        if (result.ok) setModal({ type: 'results', title: 'Uninstall', results: [{ kind: 'file', path: p.name, ok: true, detail: 'App removed' }] });
        return load();
      }
      load();
      await scanFor(p, `Uninstall – ${p.name}`, (items) =>
        result.error
          ? `${result.error} SweepUninstall found ${items.length} items.`
          : result.ok
            ? `Uninstall finished. SweepUninstall found ${items.length} leftover items.`
            : `The uninstaller exited with code ${result.code}. It may have been cancelled. SweepUninstall found ${items.length} items.`
      );
    },
    force: async (p) => {
      if (view !== 'desktop') return actions.uninstall(p);
      const go = await confirmWithRestore(
        `Force removal of ${p.name}?`,
        "This skips the program's uninstaller and deletes its files and registry entries directly. Use it for programs whose uninstaller is broken or missing. Everything is backed up first."
      );
      if (!go.ok) return;
      if (go.checked) await makeRestorePoint(`SweepUninstall: before force removal of ${p.name}`, 'uninstall');
      scanFor(p, `Force Removal – ${p.name}`, (items) => `SweepUninstall found ${items.length} items belonging to ${p.name}.`);
    },
    analyze: (p) => {
      if (view === 'desktop') scanFor(p, `Analysis – ${p.name}`, (items) => `${items.length} files, folders and registry entries are associated with ${p.name}.`);
      else if (view === 'monitored') setModal({ type: 'properties', program: p });
    },
    removeEntry: async (p) => {
      if (view !== 'desktop') return;
      if (await api.invoke('dialog:confirm', { message: `Remove ${p.name} from the list?`, detail: 'Only the uninstall entry is deleted (with a backup). Program files are not touched.' })) {
        removeWithBackup(`${p.name} (entry)`, [{ kind: 'key', path: p.key, confidence: 'high', reason: 'Uninstall entry' }]);
      }
    },
    registry: (p) => view === 'desktop' && api.invoke('program:openRegistry', p.key),
    folder: async (p) => {
      const r = await api.invoke('program:openFolder', p.location);
      if (r) setError(`${p.name}: install folder is unknown or missing.`);
    },
    search: (p) => api.invoke('program:search', p.name),
    properties: (p) => (view === 'backups' ? setModal({ type: 'results', title: `Backup – ${p.name}`, results: p.entries.map((e) => ({ ...e, ok: true, detail: e.kind === 'key' ? 'Exported .reg' : e.recycled ? 'In Recycle Bin' : '' })) }) : setModal({ type: 'properties', program: p })),
    restore: async (p) => {
      if (!(await api.invoke('dialog:confirm', { message: `Restore the backup of ${p.name}?`, detail: 'Registry keys and values are re-imported. Files must be restored from the Recycle Bin.' }))) return;
      setBusy('Restoring…');
      const results = await api.invoke('backups:restore', p.id).finally(() => setBusy(''));
      setModal({ type: 'results', title: 'Restore Report', results });
    },
    deleteBackup: async (p) => {
      if (await api.invoke('dialog:confirm', { message: `Delete the backup of ${p.name}?`, detail: 'This cannot be undone.' })) {
        await api.invoke('backups:remove', p.id);
        load();
      }
    },
  };

  const global = {
    export: () => {
      const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
      const html = `<!doctype html><meta charset="utf-8"><title>${VIEWS[view].label}</title>
<style>body{font:13px Segoe UI,sans-serif;margin:24px}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:4px 8px;border-bottom:1px solid #ddd}th{background:#f3f3f3}</style>
<h2>${VIEWS[view].label} (${visible.length})</h2><p>Exported ${new Date().toLocaleString()}</p>
<table><tr><th>Name</th><th>Version</th><th>Publisher</th><th>Size</th><th>Date</th><th>Location</th></tr>
${visible.map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.version)}</td><td>${esc(r.publisher)}</td><td>${esc(r.sizeText)}</td><td>${esc(r.date)}</td><td>${esc(r.location)}</td></tr>`).join('\n')}
</table>`;
      api.invoke('export:html', { title: 'Export to HTML', html });
    },
    elevate: () => api.invoke('app:elevate'),
    quit: () => api.invoke('app:quit'),
    find: () => searchRef.current?.focus(),
    refresh: () => load(),
    monitor: () => setModal({ type: 'monitor' }),
    about: () => setModal({ type: 'about' }),
    toggleRestore: async () => {
      const s = await api.invoke('settings:set', { createRestorePoints: !restoreOn });
      setRestoreOn(s.createRestorePoints);
      setNotice({ tone: 'ok', text: s.createRestorePoints ? 'Restore points are on: confirmations offer to create one first.' : 'Restore points are off: the checkbox starts unticked.' });
    },
  };

  const dispatch = (action) => {
    setMenu(null);
    if (action.startsWith('view:')) return setView(action.slice(5));
    if (global[action]) return global[action]();
    if (busy || modal) return;
    if (action === 'clearSelection') return setMarked(new Set(current ? [current.key] : []));
    if (action === 'uninstall' && isBatch) return batchUninstall(markedRows);
    if (current && actions[action]) actions[action](current);
  };
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;
  // Keyboard shortcuts (they match the accelerators shown in the menus).
  useEffect(() => {
    const onKey = (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      let action = null;
      if (e.ctrlKey && !e.altKey && /^[1-6]$/.test(key)) action = `view:${['desktop', 'store', 'monitored', 'backups', 'debloat', 'startup'][Number(key) - 1]}`;
      else if (e.ctrlKey && key === 'f') action = 'find';
      else if (e.ctrlKey && key === 's') action = 'export';
      else if (e.ctrlKey && key === 'm') action = 'monitor';
      else if (e.ctrlKey && key === 'l') action = 'analyze';
      else if (key === 'F5') action = 'refresh';
      else if (e.altKey && key === 'Enter') action = 'properties';
      else if (!typing && key === 'Delete') action = e.shiftKey ? 'force' : 'uninstall';
      if (!action || document.querySelector('.overlay')) return;
      e.preventDefault();
      dispatchRef.current(action);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Confirmations are shown in the app's own dialog.
  const [confirm, setConfirm] = useState(null);
  useEffect(() => setConfirmUI((options) => new Promise((resolve) => setConfirm({ ...options, resolve }))), []);
  // Sizes and dates measured from install folders arrive one program at a time.
  useEffect(
    () =>
      api.onMeasured((m) => {
        const merge = (p) => (p.key === m.key ? { ...p, ...m } : p);
        desktopCache.current = desktopCache.current.map(merge);
        setRows((rs) => rs.map((r) => (r.key === m.key ? toRow('desktop', merge(r)) : r)));
      }),
    []
  );

  // ---- keyboard navigation ---------------------------------------------------

  const onListKey = (e) => {
    if (!visible.length) return;
    const i = visible.findIndex((r) => r.key === selected);
    let next = i;
    if (e.key === 'ArrowDown') next = Math.min(visible.length - 1, i + 1);
    else if (e.key === 'ArrowUp') next = Math.max(0, i - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = visible.length - 1;
    else if (e.key === 'PageDown') next = Math.min(visible.length - 1, i + 15);
    else if (e.key === 'PageUp') next = Math.max(0, i - 15);
    else if (e.key === 'Enter') return dispatch(view === 'backups' ? 'restore' : 'properties');
    else if (e.ctrlKey && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      if (batchable) setMarked(new Set(visible.map((r) => r.key)));
      return;
    } else if (e.key.length === 1 && /\S/.test(e.key) && !e.ctrlKey && !e.altKey) {
      const ch = e.key.toLowerCase();
      const after = [...visible.slice(i + 1), ...visible.slice(0, i + 1)];
      const hit = after.find((r) => r.name.toLowerCase().startsWith(ch));
      if (hit) selectRow(hit.key);
      return;
    } else return;
    e.preventDefault();
    selectRow(visible[next].key, { shift: e.shiftKey && batchable });
    listRef.current?.querySelector(`[data-idx="${next}"]`)?.scrollIntoView({ block: 'nearest' });
  };

  const contextItems = isBatch
    ? [['uninstall', `Uninstall ${markedRows.length} Programs...`, 'Del'], null, ['clearSelection', 'Clear Selection']]
    : view === 'backups'
      ? [['restore', 'Restore'], ['properties', 'Show Contents'], null, ['deleteBackup', 'Delete Backup']]
      : view === 'monitored'
        ? [['uninstall', 'Uninstall...'], null, ['properties', 'Recorded Changes'], ['search', 'Search Online']]
        : view === 'store'
          ? [['uninstall', 'Uninstall...'], null, ['folder', 'Installation Folder'], ['search', 'Search Online'], null, ['properties', 'Properties']]
          : [
              ['uninstall', 'Uninstall...', 'Del'],
              ['force', 'Force Removal...', 'Shift+Del'],
              ['analyze', 'Analyze Leftovers...', 'Ctrl+L'],
              ['removeEntry', 'Remove Entry...'],
              null,
              ['registry', 'Registry Entry'],
              ['folder', 'Installation Folder'],
              ['search', 'Search Online'],
              null,
              ['properties', 'Properties', 'Alt+Enter'],
            ];

  const totalKB = view === 'desktop' ? visible.reduce((s, r) => s + (r.sizeKB || 0), 0) : 0;
  const cols = VIEWS[view].cols;
  const cellFor = (r, c) => (c === 'size' ? r.sizeText : c === 'date' ? r.date : r[c]);

  return (
    <div className="app" onClick={() => menu && setMenu(null)}>
      <MenuBar onAction={dispatch} checked={{ toggleRestore: restoreOn }} />
      <div className="toolbar">
        <div className="toolbar-left">
          <select
            className={`view-picker ${view === 'debloat' ? 'inactive' : ''}`}
            value={view === 'debloat' ? lastListView.current : view}
            onChange={(e) => setView(e.target.value)}
            onClick={() => view === 'debloat' && setView(lastListView.current)}
            aria-label="View"
          >
            {Object.entries(VIEWS)
              .filter(([, v]) => !v.button)
              .map(([id, v]) => (
                <option key={id} value={id}>
                  {v.label}
                </option>
              ))}
          </select>
          <button
            className={`debloat-button ${view === 'debloat' ? 'active' : ''}`}
            onClick={() => setView(view === 'debloat' ? lastListView.current : 'debloat')}
            aria-pressed={view === 'debloat'}
            title="Safe, reversible tweaks that remove Windows ads, telemetry and clutter (Ctrl+5)"
          >
            Debloat Windows
          </button>
        </div>
        <div className="search">
          <input ref={searchRef} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search" onKeyDown={(e) => e.key === 'Escape' && setFilter('')} />
          {filter && (
            <button className="clear" onClick={() => setFilter('')} aria-label="Clear search">
              ✕
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="error-bar">
          <span>{error}</span>
          <button onClick={() => setError('')}>✕</button>
        </div>
      )}
      {notice && (
        <div className={`notice-bar ${notice.tone}`}>
          <span>{notice.text}</span>
          <button onClick={() => setNotice(null)} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}

      {view === 'debloat' ? (
        <DebloatView key={customKey} filter={filter} admin={admin} onError={setError} onStatus={setCustomStatus} beforeChange={beforeDebloatChange} />
      ) : view === 'startup' ? (
        <StartupView key={customKey} filter={filter} admin={admin} programs={desktopCache.current} onError={setError} onStatus={setCustomStatus} />
      ) : (
      <div className="list" tabIndex={0} ref={listRef} onKeyDown={onListKey}>
        <div className="list-header">
          {cols.map(([id, label]) => (
            <div key={id} className={`col col-${id}`} onClick={() => setSort((s) => ({ col: id, dir: s.col === id ? -s.dir : 1 }))}>
              {label}
              {sort.col === id && <span className="sort">{sort.dir > 0 ? '▲' : '▼'}</span>}
            </div>
          ))}
        </div>
        {loading ? (
          <div className="list-empty">Loading…</div>
        ) : visible.length === 0 ? (
          <div className="list-empty">
            {filter ? 'No matches.' : view === 'monitored' ? 'No monitored programs yet. Use Tools › Monitor an Installation.' : view === 'backups' ? 'No backups yet.' : 'Nothing found.'}
          </div>
        ) : (
          visible.map((r, idx) => (
            <div
              key={r.key}
              data-idx={idx}
              className={`row ${marked.has(r.key) ? 'selected' : ''} ${r.key === selected ? 'focused' : ''} ${r.arch === 'user' ? 'user' : ''}`}
              onMouseDown={(e) => e.button === 0 && selectRow(r.key, { ctrl: batchable && e.ctrlKey, shift: batchable && e.shiftKey })}
              onDoubleClick={(e) => !e.ctrlKey && !e.shiftKey && dispatch(view === 'backups' ? 'restore' : 'uninstall')}
              onContextMenu={(e) => {
                e.preventDefault();
                if (!marked.has(r.key)) selectRow(r.key);
                else setSelected(r.key);
                setMenu({ x: Math.min(e.clientX, window.innerWidth - 220), y: Math.min(e.clientY, window.innerHeight - contextItems.length * 24 - 10) });
              }}
            >
              {cols.map(([id]) => (
                <div key={id} className={`col col-${id}`}>
                  {id === 'name' && (
                    <span className="icon">{icons[r.key] ? <img src={icons[r.key]} alt="" /> : <span className={`generic-icon ${view}`} />}</span>
                  )}
                  <span
                    className={`cell-text ${(id === 'size' && r.sizeMeasured) || (id === 'date' && r.dateMeasured) ? 'measured' : ''}`}
                    title={
                      id === 'size' && r.sizeMeasured
                        ? `Measured from ${r.folder}${r.sizeTruncated ? ' (stopped early; at least this size)' : ''}`
                        : id === 'date' && r.dateMeasured
                          ? `Date the folder ${r.folder} was created`
                          : undefined
                    }
                  >
                    {cellFor(r, id)}
                    {id === 'size' && r.sizeTruncated ? '+' : ''}
                  </span>
                </div>
              ))}
            </div>
          ))
        )}
      </div>
      )}

      <div className="statusbar">
        {VIEWS[view].custom ? (
          <span>{customStatus}</span>
        ) : (
          <span>
            {loading ? 'Loading' : visible.length} {VIEWS[view].noun}
            {totalKB ? `, total size ${formatSize(totalKB)}` : ''}
            {filter && rows.length !== visible.length ? ` (of ${rows.length})` : ''}
            {isBatch ? `, ${markedRows.length} selected` : ''}
          </span>
        )}
        <span className="status-right">
          {current && view === 'desktop' && <span className="muted">{current.publisher}</span>}
          {admin === false && (
            <button className="link" onClick={() => api.invoke('app:elevate')} title="Needed to remove programs installed for all users">
              Not elevated – Restart as Administrator
            </button>
          )}
          {admin && <span>Administrator</span>}
        </span>
      </div>

      {menu && current && (
        <div className="context-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          {contextItems.map((it, i) =>
            it ? (
              <button key={i} className={i === 0 ? 'bold' : ''} onClick={() => dispatch(it[0])}>
                <span>{it[1]}</span>
                <span className="accel">{it[2]}</span>
              </button>
            ) : (
              <div key={i} className="sep" />
            )
          )}
        </div>
      )}

      {busy && <Busy message={busy} onStop={busyStop} />}
      {confirm && (
        <ConfirmDialog
          {...confirm}
          onAnswer={(answer) => {
            setConfirm(null);
            confirm.resolve(confirm.checkboxLabel ? answer : answer.ok);
          }}
        />
      )}
      {modal?.type === 'leftovers' && <LeftoversDialog {...modal} onClose={() => setModal(null)} />}
      {modal?.type === 'results' && <ResultsDialog {...modal} onClose={() => setModal(null)} />}
      {modal?.type === 'properties' && <PropertiesDialog program={modal.program} onClose={() => setModal(null)} />}
      {modal?.type === 'about' && <AboutDialog onClose={() => setModal(null)} />}
      {modal?.type === 'monitor' && (
        <MonitorWizard
          resume={modal.resume}
          onClose={() => setModal(null)}
          onRecorded={(rec) => {
            setModal({ type: 'properties', program: rec });
            setView('monitored');
            load('monitored');
          }}
        />
      )}
    </div>
  );
}
