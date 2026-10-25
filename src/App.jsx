import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AboutDialog, Busy, ConfirmDialog, LeftoversDialog, MonitorWizard, PropertiesDialog, ResultsDialog, InterruptedDialog, BackupSettingsDialog, planHtml } from './dialogs.jsx';
import { setConfirmUI } from './backend/api.js';
import { applyZoom, nextStep } from './zoom.js';
import { TakeSnapshotDialog, ComparisonDialog, SnapshotTimeline, comparisonHtml } from './snapshots.jsx';
import { DebloatView } from './debloat.jsx';
import { StartupView } from './startup.jsx';
import { JunkView, formatBytes } from './junk.jsx';
import { GroupDialog } from './groups.jsx';
import { ProgramBackupDialog, ProgramRestoreDialog } from './transfer.jsx';
import { WhoOwnsDialog, UpdatesDialog, MaintenanceDialog } from './tools.jsx';
import { QueueDialog, OutsideDialog, TrialsDialog, DiskMapDialog, SheetDialog, PromptDialog, StartupAlertDialog, BrowsersDialog, MigratePcDialog, FolderRestoreDialog, SyncDialog, PortableDialog, CommandPalette, ReportDialog, ContextMenuDialog } from './more.jsx';

const api = window.api;

const VIEWS = {
  desktop: { label: 'Programs', noun: 'programs', cols: [['name', 'Name'], ['size', 'Size'], ['date', 'Installed On']] },
  store: { label: 'Apps', noun: 'apps', cols: [['name', 'Name'], ['version', 'Version'], ['publisher', 'Publisher']] },
  // Views below are opened from toolbar buttons or the Tools menu, not the view picker.
  monitored: { label: 'Monitored Programs', noun: 'monitored programs', cols: [['name', 'Name'], ['size', 'Changes'], ['date', 'Monitored On']], button: true },
  backups: { label: 'Backups', noun: 'backups', cols: [['name', 'Removed'], ['size', 'Entries'], ['date', 'Backed Up On']], button: true },
  snapshots: { label: 'Snapshots', noun: 'snapshots', cols: [['name', 'Snapshot'], ['size', 'Entries'], ['date', 'Taken On']], button: true },
  history: { label: 'Change History', noun: 'changes', cols: [['name', 'Change'], ['size', 'Type'], ['date', 'When']], button: true },
  startup: { label: 'Startup & Services', noun: 'entries', cols: [], custom: true, button: true },
  debloat: { label: 'Debloat', noun: 'tweaks', cols: [], button: true, custom: true },
  junk: { label: 'Cleaner', noun: 'categories', cols: [], button: true, custom: true },
  timeline: { label: 'Change Timeline', noun: 'events', cols: [['name', 'Event'], ['size', 'Type'], ['date', 'When']], button: true },
  archive: { label: 'Uninstall Archive', noun: 'removed programs', cols: [['name', 'Removed Program'], ['size', 'How'], ['date', 'Removed On']], button: true },
};

// The view chips under the command bar.
const VIEW_CHIPS = [
  ['desktop', 'Programs', 'Desktop programs installed on this PC (Ctrl+1)'],
  ['store', 'Apps', 'Windows Store apps from the Microsoft Store (Ctrl+2)'],
  ['monitored', 'Monitored', 'Monitored programs: programs recorded with Tools › Monitor an Installation (Ctrl+3)'],
  ['startup', 'Startup', 'Startup & Services: programs, tasks and services that start with Windows (Ctrl+6)'],
  ['debloat', 'Debloat', 'Debloat Windows: safe, reversible tweaks that remove Windows ads, telemetry and clutter (Ctrl+5)'],
  ['junk', 'Cleaner', 'Cleaner: temporary files, crash dumps and caches that can be cleaned (Ctrl+8)'],
  ['snapshots', 'Snapshots', 'Take snapshots and compare them to see what changed (Ctrl+7)'],
  ['archive', 'Archive', 'Uninstall archive: programs removed so far, with how to get them back (Ctrl+9)'],
  ['timeline', 'Timeline', 'Change timeline: everything that changed, newest first (Ctrl+T)'],
];

// What the action bar says in views that have their own buttons.
const VIEW_NOTES = {
  startup: 'Startup & Services · turn entries off and on; nothing is deleted',
  debloat: 'Debloat · every tweak can be undone',
  junk: 'Cleaner · tick categories, then clean; files go to the Recycle Bin',
};

// The action bar's buttons for a desktop program, in order.
const DESKTOP_BAR = ['uninstall', 'force', 'analyze', 'sheet', 'backupProgram', 'queueAdd', 'properties'];
const shortLabel = (label) => label.replace(/\.\.\.$/, '').replace('Migrate / Back Up Program', 'Migrate').replace('Analyze Leftovers', 'Leftovers').replace('Add to Uninstall Queue', 'Queue').replace('Compare the Two Selected', 'Compare Selected');

// Group-picker entries that filter by insight rather than by group.
const INSIGHT_FILTERS = [
  ['\u0001offer', 'Possible bundled offers', (i) => i?.offer],
  ['\u0001together', 'Installed together with another', (i) => i?.together],
  ['\u0001unsigned', 'Unsigned or bad signature', (i) => i?.signature && i.signature !== 'Valid'],
  ['\u0001growing', 'Growing in size', (i) => i?.growth],
];

// Group filter values besides a group's name.
const ALL_GROUPS = '';
const UNGROUPED = '\u0000ungrouped';

const formatSize = (kb) => {
  if (!kb) return '';
  if (kb < 1024) return `${kb} KB`;
  if (kb < 1024 * 1024) return `${(kb / 1024).toFixed(1)} MB`;
  return `${(kb / 1024 / 1024).toFixed(2)} GB`;
};

// "2026-10-24 14:05" in local time.
const localTime = (iso) => {
  const t = new Date(iso);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')} ${t.toTimeString().slice(0, 5)}`;
};

const normKey = (k) => (k || '').replace(/^HKEY_LOCAL_MACHINE\\/i, 'HKLM\\').replace(/^HKEY_CURRENT_USER\\/i, 'HKCU\\').toLowerCase();

// Shape every view's records into one row type for the list.
function toRow(view, r) {
  if (view === 'monitored') return { ...r, key: r.id, sizeText: `${r.items.length} items`, sortSize: r.items.length, date: r.finished.slice(0, 10) };
  if (view === 'backups') return { ...r, key: r.id, name: r.title, sizeText: `${r.entries.length}`, sortSize: r.entries.length, date: r.created.slice(0, 10) };
  if (view === 'snapshots') {
    const n = r.stats.dirs + r.stats.files + r.stats.keys + r.stats.values;
    return { ...r, key: r.id, sizeText: n.toLocaleString(), sortSize: n, date: localTime(r.created), sortDate: r.created };
  }
  if (view === 'timeline') return { ...r, key: r.id, name: r.title, sizeText: r.type, sortSize: r.type, date: localTime(r.time), sortDate: r.time };
  if (view === 'archive') {
    const how = { uninstalled: 'Uninstalled', forced: 'Force removed', store: 'Store app removed' }[r.how] || r.how;
    return { ...r, key: r.id, name: r.version ? `${r.name} ${r.version}` : r.name, sizeText: how, sortSize: how, date: localTime(r.removed), sortDate: r.removed };
  }
  if (view === 'history') {
    return { ...r, key: r.id, name: r.undone ? `${r.title}  (undone)` : r.title, sizeText: r.type, sortSize: r.type, date: localTime(r.time), sortDate: r.time };
  }
  return { ...r, sizeText: formatSize(r.sizeKB), sortSize: r.sizeKB || 0, date: r.installDate };
}

// Small tags after a program's name for what the insights found.
function InsightTags({ i }) {
  if (!i) return null;
  return (
    <>
      {i.signature && i.signature !== 'Valid' && (
        <span className="insight-tag bad" title={i.signature === 'NotSigned' ? 'Its program file is not digitally signed' : `Signature problem: ${i.signature}`}>
          {i.signature === 'NotSigned' ? 'unsigned' : 'bad signature'}
        </span>
      )}
      {i.offer && (
        <span className="insight-tag offer" title="Its name matches a type of program often installed as a bundled offer">
          possible offer
        </span>
      )}
      {i.together && (
        <span className="insight-tag together" title={`Installed or updated at the same time as: ${i.together.join(', ')}`}>
          installed with {i.together[0]}
          {i.together.length > 1 ? ` +${i.together.length - 1}` : ''}
        </span>
      )}
      {i.growth && (
        <span className="insight-tag growing" title={`Grew from ${(i.growth.fromKB / 1024).toFixed(0)} MB to ${(i.growth.toKB / 1024).toFixed(0)} MB since ${i.growth.since}`}>
          growing
        </span>
      )}
    </>
  );
}

// The menu bar. The shortcuts shown here are handled by the keydown listener in App.
const MENUS = [
  [
    'File',
    [
      ['export', 'Export to HTML...', 'Ctrl+S'],
      ['report', 'Monthly Report...'],
      null,
      ['migratePc', 'Migrate This PC...'],
      ['restoreFolder', 'Restore Programs From Folder...'],
      ['sync', 'Settings Sync...'],
      null,
      ['elevate', 'Restart as Administrator'],
      null,
      ['quit', 'Exit'],
    ],
  ],
  [
    'Action',
    [
      ['uninstall', 'Uninstall...', 'Del'],
      ['force', 'Force Removal...', 'Shift+Del'],
      ['analyze', 'Analyze Leftovers...', 'Ctrl+L'],
      ['queueAdd', 'Add to Uninstall Queue', 'Ctrl+Q'],
      ['rescue', 'Rescue Broken Uninstall...'],
      ['removeEntry', 'Remove Entry...'],
      null,
      ['sheet', 'What It Does...', 'Ctrl+W'],
      ['setGroup', 'Set Group...', 'Ctrl+G'],
      ['backupProgram', 'Migrate / Back Up Program...'],
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
      ['view:desktop', 'Programs', 'Ctrl+1'],
      ['view:store', 'Apps', 'Ctrl+2'],
      ['view:monitored', 'Monitored Programs', 'Ctrl+3'],
      ['view:debloat', 'Debloat', 'Ctrl+5'],
      ['view:startup', 'Startup & Services', 'Ctrl+6'],
      ['view:junk', 'Cleaner', 'Ctrl+8'],
      ['view:archive', 'Uninstall Archive', 'Ctrl+9'],
      ['view:timeline', 'Change Timeline', 'Ctrl+T'],
      ['diskMap', 'Disk Space Map...'],
      null,
      ['palette', 'Command Palette...', 'Ctrl+K'],
      ['find', 'Find...', 'Ctrl+F'],
      ['refresh', 'Refresh', 'F5'],
      null,
      ['zoomIn', 'Zoom In', 'Ctrl++'],
      ['zoomOut', 'Zoom Out', 'Ctrl+-'],
      ['zoomReset', 'Reset Zoom', 'Ctrl+0'],
      null,
      ['toggleGrid', 'Grid Lines'],
      ['theme:dark', 'Dark Theme'],
      ['theme:light', 'Light Theme'],
      ['theme:contrast', 'High Contrast'],
      null,
      ['toggleTray', 'Keep Running in the Tray'],
    ],
  ],
  [
    'Tools',
    [
      ['monitor', 'Monitor an Installation...', 'Ctrl+M'],
      ['trials', 'Trial Installs...'],
      ['queue', 'Uninstall Queue...'],
      null,
      ['view:backups', 'Backups', 'Ctrl+4'],
      ['view:history', 'Change History', 'Ctrl+H'],
      ['view:snapshots', 'Snapshots', 'Ctrl+7'],
      ['takeSnapshot', 'Take a Snapshot...'],
      null,
      ['restoreProgram', 'Restore a Program Backup...'],
      ['whoOwns', 'Who Owns This...'],
      ['orphans', 'Find Orphaned Leftovers...'],
      ['regSearch', 'Search Registry...'],
      ['portable', 'Portable Apps...'],
      ['browsers', 'Browser Clean-up...'],
      ['view:archive', 'Uninstall Archive', 'Ctrl+9'],
      null,
      ['updates', 'Program Updates (winget)...'],
      ['exportWinget', 'Export Program List (winget)...'],
      ['view:junk', 'Cleaner', 'Ctrl+8'],
      ['maintenance', 'Scheduled Maintenance...'],
      null,
      ['toggleRestore', 'Create Restore Points'],
      ['toggleSilent', 'Silent Uninstall When Possible'],
      ['toggleSafe', 'Safe Mode'],
      ['toggleShell', 'Explorer Right-Click Menu'],
      ['ctxmenu', 'Explorer Context Menu Items...'],
      null,
      ['backupSettings', 'Backup Settings...'],
      ['openLog', 'Open Command Log'],
    ],
  ],
  ['Help', [['palette', 'Command Palette...', 'Ctrl+K'], ['about', 'About']]],
];

// Mouse or keyboard: Alt plus a menu's first letter opens it; arrow keys move between items and
// menus, Enter chooses, Escape closes.
function MenuBar({ onAction, checked = {}, right = null }) {
  const [open, setOpen] = useState(null);
  const bar = useRef(null);
  const focusItem = (step) => {
    const items = [...(bar.current?.querySelectorAll('.dropdown button') || [])];
    if (!items.length) return;
    const at = items.indexOf(document.activeElement);
    items[(at + step + items.length) % items.length].focus();
  };
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
  useEffect(() => {
    const onKey = (e) => {
      if (e.altKey && !e.ctrlKey && /^[a-z]$/i.test(e.key)) {
        const i = MENUS.findIndex(([label]) => label[0].toLowerCase() === e.key.toLowerCase());
        if (i >= 0 && !document.querySelector('.overlay')) {
          e.preventDefault();
          setOpen(i);
          setTimeout(() => focusItem(1), 0);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const onMenuKey = (e, i) => {
    if (e.key === 'ArrowDown') (e.preventDefault(), focusItem(1));
    else if (e.key === 'ArrowUp') (e.preventDefault(), focusItem(-1));
    else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      setOpen((i + (e.key === 'ArrowRight' ? 1 : MENUS.length - 1)) % MENUS.length);
      setTimeout(() => focusItem(1), 0);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setOpen(null);
    }
  };
  return (
    <div className="menubar" role="menubar" ref={bar} onMouseDown={(e) => e.stopPropagation()}>
      {MENUS.map(([label, entries], i) => (
        <div key={label} className="menubar-item">
          <button
            className={open === i ? 'open' : ''}
            aria-haspopup="menu"
            aria-expanded={open === i}
            onClick={() => setOpen(open === i ? null : i)}
            onMouseEnter={() => open !== null && setOpen(i)}
            onKeyDown={(e) => e.key === 'ArrowDown' && (e.preventDefault(), setOpen(i), setTimeout(() => focusItem(1), 0))}
          >
            <u>{label[0]}</u>
            {label.slice(1)}
          </button>
          {open === i && (
            <div className="context-menu dropdown" role="menu" onKeyDown={(e) => onMenuKey(e, i)}>
              {entries.map((it, j) =>
                it ? (
                  <button
                    key={j}
                    role={it[0] in checked ? 'menuitemcheckbox' : 'menuitem'}
                    aria-checked={it[0] in checked ? !!checked[it[0]] : undefined}
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
                  <div key={j} className="sep" role="separator" />
                )
              )}
            </div>
          )}
        </div>
      ))}
      {right && <div className="menubar-right">{right}</div>}
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
  const [silentOn, setSilentOn] = useState(false);
  const [safeOn, setSafeOn] = useState(false);
  const [gridOn, setGridOn] = useState(true);
  const [theme, setTheme] = useState('dark');
  const [trayOn, setTrayOn] = useState(false);
  const [shellOn, setShellOn] = useState(false);
  const [palette, setPalette] = useState(false);
  const outsideChecked = useRef(false);
  const [zoom, setZoom] = useState(1);
  // Program groups ({ programKey: group }) and the group the program lists are filtered to.
  const [groups, setGroups] = useState({});
  const [groupFilter, setGroupFilter] = useState(ALL_GROUPS);
  // Per-program insights (signature, installed together, offers, growth), loaded after the list.
  const [insight, setInsight] = useState({});
  const sizeTimer = useRef(null);
  const groupNames = useMemo(() => [...new Set(Object.values(groups))].sort((a, b) => a.localeCompare(b)), [groups]);
  const debloatGatePassed = useRef(false);
  const searchRef = useRef(null);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [cmdIdx, setCmdIdx] = useState(-1);
  const listRef = useRef(null);
  const desktopCache = useRef([]);
  const lastListView = useRef('desktop');
  // Debloat and Startup views load their own data; their status text and remount key live here.
  const [customStatus, setCustomStatus] = useState('');
  const [customKey, setCustomKey] = useState(0);
  // The program list to go back to when a toolbar view is closed.
  if (!VIEWS[view].button) lastListView.current = view;
  const toggleView = (v) => setView(view === v ? lastListView.current : v);

  const load = useCallback(async (v = view) => {
    if (VIEWS[v].custom) return setCustomKey((k) => k + 1);
    setLoading(true);
    setError('');
    try {
      let data;
      if (v === 'monitored') data = await api.invoke('monitor:list');
      else if (v === 'backups') data = await api.invoke('backups:list');
      else if (v === 'history') data = await api.invoke('history:list');
      else if (v === 'snapshots') data = await api.invoke('snapshots:list');
      else if (v === 'archive') data = await api.invoke('archive:list');
      else if (v === 'timeline') data = await api.invoke('explore:timeline', desktopCache.current);
      else data = await api.invoke('programs:list', v);
      if (v === 'desktop') {
        desktopCache.current = data;
        api.invoke('programs:measure', data).catch(() => {});
        api.invoke('programs:insights', data).then(setInsight).catch(() => {});
        if (!outsideChecked.current) {
          outsideChecked.current = true;
          api.invoke('programs:outside', data).then((gone) => gone.length && setModal((m) => m || { type: 'outside', programs: gone })).catch(() => {});
        }
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
    // Change History reads newest first; every other list starts alphabetical.
    setSort(view === 'history' || view === 'timeline' ? { col: 'date', dir: -1 } : { col: 'name', dir: 1 });
    anchor.current = null;
    if (!VIEWS[view].custom) load(view);
    else setCustomStatus('');
    // The Startup view names the program each entry belongs to, so it needs the program list.
    if (view === 'startup' && !desktopCache.current.length) api.invoke('programs:list', 'desktop').then((d) => (desktopCache.current = d)).catch(() => {});
  }, [view]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    api.invoke('app:isAdmin').then(setAdmin);
    api.invoke('settings:get').then((s) => {
      setRestoreOn(s.createRestorePoints);
      setSilentOn(!!s.silentUninstall);
      setSafeOn(!!s.safeMode);
      setGridOn(s.gridLines !== false);
      setTheme(s.theme || 'dark');
      setTrayOn(!!s.tray);
      if (s.tray) api.invoke('app:setTray', true).catch(() => {});
      api.invoke('backups:prune').catch(() => {});
      setZoom(s.zoom || 1);
      applyZoom(s.zoom || 1);
    });
    api.invoke('monitor:status').then((s) => s && setModal({ type: 'monitor', resume: s }));
    // A removal cut off by a crash or power cut comes first.
    api.invoke('backups:interrupted').then((p) => p && setModal({ type: 'interrupted', pending: p })).catch(() => {});
    api.invoke('groups:get').then(setGroups).catch(() => {});
    api.invoke('shell:enabled').then(setShellOn).catch(() => {});
    // Requests from the command line, the Explorer right-click menu and the RunOnce entry.
    const launch = window.__sweepLaunch || [];
    const arg = (name) => {
      const i = launch.findIndex((a) => a.toLowerCase() === name);
      return i >= 0 ? launch[i + 1] || '' : null;
    };
    if (launch.some((a) => a.toLowerCase() === '--resume-queue')) setTimeout(() => openQueue(), 1500);
    else
      api.invoke('queue:get').then((q) => q?.restartNeeded && q.programs.some((p) => p.status === 'pending') && setModal({ type: 'queue', queue: q })).catch(() => {});
    if (arg('--who-owns')) setModal({ type: 'whoOwns', target: arg('--who-owns') });
    if (arg('--uninstall-target')) setTimeout(() => uninstallTarget(arg('--uninstall-target')), 2500);
    // New startup entries: checked now and every 10 minutes while SweepUninstall runs (also from the tray).
    const first = setTimeout(() => checkStartup(), 8000);
    const every = setInterval(() => checkStartup(), 10 * 60 * 1000);
    // Tray menu choices.
    let unlisten = null;
    import('@tauri-apps/api/event')
      .then(({ listen }) => listen('tray', (e) => (e.payload === 'junk' ? setView('junk') : e.payload === 'updates' ? setModal({ type: 'updates' }) : null)))
      .then((u) => (unlisten = u))
      .catch(() => {});
    return () => {
      clearTimeout(first);
      clearInterval(every);
      unlisten?.();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The theme lives on the root element so dialogs and menus follow it too.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

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
    const programs = view === 'desktop' || view === 'store';
    const insightFilter = INSIGHT_FILTERS.find(([id]) => id === groupFilter);
    const inGroup = (r) =>
      !programs || groupFilter === ALL_GROUPS || (insightFilter ? !!insightFilter[2](insight[r.key]) : groupFilter === UNGROUPED ? !groups[r.key] : groups[r.key] === groupFilter);
    const list = rows.filter((r) => inGroup(r) && (!q || `${r.name} ${r.publisher || ''} ${(programs && groups[r.key]) || ''}`.toLowerCase().includes(q)));
    const val = (r) => (sort.col === 'size' ? r.sortSize : sort.col === 'date' && r.sortDate ? r.sortDate : (r[sort.col] || '').toString().toLowerCase());
    return [...list].sort((a, b) => {
      const x = val(a);
      const y = val(b);
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
    });
  }, [rows, filter, sort, groups, groupFilter, view, insight]);

  const current = visible.find((r) => r.key === selected) || null;
  const markedRows = visible.filter((r) => marked.has(r.key));
  const batchable = view === 'desktop' || view === 'store';
  // Lists where several rows can be selected: programs (batch uninstall) and snapshots (compare two).
  const multi = batchable || view === 'snapshots';
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

  // Zoom steps are remembered between sessions.
  const changeZoom = async (direction) => {
    const next = nextStep(zoom, direction);
    setZoom(next);
    await api.invoke('settings:set', { zoom: next });
    await applyZoom(next);
    setNotice({ tone: 'ok', text: `Zoom ${Math.round(next * 100)}%` });
  };

  // Reverses one Change History entry and reports what happened.
  const runUndo = async (historyId, title) => {
    setModal(null);
    setBusy('Undoing…');
    try {
      const result = await api.invoke('history:undo', historyId);
      if (Array.isArray(result)) setModal({ type: 'results', title: 'Undo Report', results: result });
      else setNotice({ tone: 'ok', text: `Undone: ${title}` });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
      api.invoke('groups:get').then(setGroups).catch(() => {});
      load();
    }
  };

  // The Removal Report's Undo button: restore that backup through its history entry.
  const undoRemoval = async (backupId) => {
    const entry = (await api.invoke('history:list')).find((e) => e.undo?.channel === 'backups:restore' && e.undo.arg === backupId && !e.undone);
    if (entry) return runUndo(entry.id, entry.title);
    setModal(null);
    setBusy('Restoring…');
    try {
      setModal({ type: 'results', title: 'Undo Report', results: await api.invoke('backups:restore', backupId) });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
      load();
    }
  };

  // Reads what must be known before uninstalling: installer type, silent switches, the files the
  // installer recorded and what depends on each program. One entry per program, in order.
  const prepare = async (list) => {
    if (!list.length) return [];
    setBusy(list.length === 1 ? `Checking ${list[0].name}…` : `Checking ${list.length} programs…`);
    try {
      return await Promise.all(list.map((p) => api.invoke('program:prepare', p).catch(() => null)));
    } finally {
      setBusy('');
    }
  };
  const prepNote = (info, uninstalling = true) => {
    if (!info) return '';
    const parts = [];
    if (info.dependencies?.note) parts.push(`⚠ ${info.dependencies.note}`);
    if (uninstalling && info.installer.label) parts.push(`Installer: ${info.installer.label}${silentOn ? (info.installer.silent ? ' (runs silently)' : ' (no known silent mode, its window will appear)') : ''}.`);
    if (info.installerItems?.length) parts.push(`Its installer recorded ${info.installerItems.length} files, folders or settings; they are included in the leftover scan.`);
    return parts.length ? `\n\n${parts.join('\n\n')}` : '';
  };

  // `owners`: uninstall keys of the programs being removed; anything another installed program still uses is skipped.
  const removeWithBackup = async (title, items, location, owners = []) => {
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
      const { results, backupId } = await api.invoke('items:remove', { title, items, owners });
      if (backupId && owners.length) api.invoke('archive:attachBackup', { keys: owners, backupId }).catch(() => {});
      setModal({
        type: 'results',
        title: 'Removal Report',
        results,
        note: 'A backup was saved. Click Undo to put everything back now, or later from Tools › Change History.',
        ...(backupId && { onUndo: () => undoRemoval(backupId) }),
      });
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
      owners: [p.key],
      onRemove: async (sel) => {
        // A force removal that deletes the uninstall entry removes the program: record it in the archive.
        if (/^Force Removal/.test(title) && sel.some((i) => i.kind === 'key' && i.path.toLowerCase().endsWith(p.key.split('\\').pop().toLowerCase()))) {
          await api.invoke('archive:add', { program: p, how: 'forced' }).catch(() => {});
        }
        return removeWithBackup(p.name, sel, p.location, [p.key]);
      },
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
      owners: [...rec.uninstallKeys, registered?.key].filter(Boolean),
      onRemove: async (sel) => {
        if (await removeWithBackup(rec.name, sel, null, [...rec.uninstallKeys, registered?.key].filter(Boolean))) {
          await api.invoke('monitor:remove', rec.id);
          load();
        }
      },
    });
  };

  // Runs each program's own uninstaller in turn, then shows one combined leftover list.
  const batchUninstall = async (list) => {
    const prep = await prepare(list.filter((p) => !p.store));
    const infoFor = (p) => prep[list.filter((x) => !x.store).indexOf(p)];
    const line = (p) => {
      const info = infoFor(p);
      const tags = [info?.installer.label, silentOn && info?.installer.silent ? 'silent' : '', info?.dependencies?.kind === 'runtime' ? '⚠ shared runtime' : info?.dependencies?.kind === 'driver' ? '⚠ driver' : '', info?.dependencies?.dependents?.length ? `⚠ needed by ${info.dependencies.dependents.join(', ')}` : ''].filter(Boolean);
      return `• ${p.name}${tags.length ? `  (${tags.join(', ')})` : ''}`;
    };
    const go = await confirmWithRestore(
      `Uninstall ${list.length} programs?`,
      `${list.map(line).join('\n')}\n\nEach program's own uninstaller runs in turn${silentOn ? '; ones marked silent run without their windows' : ', so finish each uninstaller\'s window'}. Afterwards SweepUninstall scans all of them for leftovers.`
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
      const found = await api.invoke('program:scan', { ...p, installerItems: infoFor(p)?.installerItems || [] }).catch(() => []);
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
      owners: list.map((p) => p.key),
      onRemove: (sel) => removeWithBackup(`Batch uninstall (${list.length} programs)`, sel, ran.map((o) => o.p.location), list.map((p) => p.key)),
    });
  };

  // ---- snapshots -----------------------------------------------------------

  const takeSnapshot = async (name, preset) => {
    setModal(null);
    setBusy(`Taking snapshot "${name}"…\nThis takes about ${{ quick: 'a few seconds', standard: '10–20 seconds', deep: 'a minute or more' }[preset]}.`);
    try {
      const meta = await api.invoke('snapshots:take', { name, preset });
      const s = meta.stats;
      setNotice({ tone: 'ok', text: `Snapshot "${meta.name}" taken: ${(s.dirs + s.files).toLocaleString()} files and folders, ${(s.keys + s.values).toLocaleString()} registry entries in ${(s.ms / 1000).toFixed(1)} s.` });
      if (view !== 'snapshots') setView('snapshots');
      else load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  };

  // Compares `before` with `after`, or with the system now when `after` is null.
  const runCompare = async (before, after) => {
    const [a, b] = after && after.created < before.created ? [after, before] : [before, after];
    setBusy(b ? `Comparing "${a.name}" with "${b.name}"…` : `Comparing "${a.name}" with the system now…\nA fresh snapshot is taken first.`);
    try {
      const comparison = await api.invoke('snapshots:compare', { before: a.id, after: b ? b.id : 'now' });
      setModal({ type: 'compare', comparison, beforeName: a.name, afterName: b ? b.name : 'Now' });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  };

  const cleanupComparison = async (comparison, beforeName, chosen) => {
    const go = await confirmWithRestore(
      `Clean up ${chosen.length} selected difference${chosen.length === 1 ? '' : 's'}?`,
      'Added items are removed, and changed or removed registry values and keys are put back from the earlier snapshot. Everything is backed up first and can be undone.'
    );
    if (!go.ok) return;
    if (go.checked) await makeRestorePoint(`SweepUninstall: before cleaning up changes since ${beforeName}`, 'settings');
    setBusy('Preparing the cleanup…');
    let items;
    try {
      items = await api.invoke('snapshots:cleanupItems', { before: comparison.beforeId, selected: chosen });
    } catch (e) {
      setBusy('');
      return setError(e.message);
    }
    setBusy('');
    removeWithBackup(`Cleanup since ${beforeName}`, items);
  };

  // ---- junk files and groups -----------------------------------------------

  const cleanJunk = async (items, categories, bytes, system = []) => {
    if (items.length) {
      const ok = await api.invoke('dialog:confirm', {
        message: `Clean ${formatBytes(bytes)} of junk files?`,
        detail: `${categories.map((c) => `• ${c.label}: ${formatBytes(c.bytes)}`).join('\n')}\n\n${items.length.toLocaleString()} items go to the Recycle Bin. You can undo this from Tools › Change History until the Recycle Bin is emptied.`,
      });
      if (!ok) return;
      await removeWithBackup(`Junk files (${categories.map((c) => c.label).join(', ')})`, items);
    }
    if (!system.length) return;
    // Windows' own clean-ups are permanent, so they get their own, explicit confirmation.
    const go = await api.invoke('dialog:confirm', {
      message: `Run ${system.length} permanent Windows clean-up${system.length === 1 ? '' : 's'}?`,
      detail: `${system.map((c) => `• ${c.label}: ${c.detail}`).join('\n')}\n\nWindows does these itself. They cannot be undone, and some take several minutes.`,
    });
    if (!go) return;
    setModal(null);
    setBusy(`Running Windows clean-up…\nThis can take several minutes.`);
    try {
      const results = await api.invoke('junk:cleanSystem', system.map((c) => c.id));
      setModal({
        type: 'results',
        title: 'Windows Clean-up Report',
        results: results.map((r) => ({ kind: 'junk', path: r.label, ok: r.ok, detail: `${r.detail}${r.freed ? ` · ${formatBytes(r.freed)} freed` : ''}` })),
      });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
      load();
    }
  };

  // ---- tools: who owns, orphans, updates, maintenance ----------------------------

  const findOrphans = async () => {
    setBusy('Looking for leftovers of programs that are no longer installed…\nThis can take a minute.');
    try {
      const items = await api.invoke('orphans:scan');
      setModal({
        type: 'leftovers',
        title: 'Orphaned Leftovers',
        heading: `${items.length} folders, registry keys and services match no installed program. Nothing is selected: check each one (Tools › Who Owns This helps) before removing it.`,
        items,
        owners: [],
        onRemove: (sel) => removeWithBackup('Orphaned leftovers', sel),
      });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  };
  const runUpdates = async (list) => {
    setModal(null);
    const go = await confirmWithRestore(`Update ${list.length} program${list.length === 1 ? '' : 's'}?`, `${list.map((u) => `• ${u.name}: ${u.version} → ${u.available}`).join('\n')}\n\nwinget updates them one after another, silently.`);
    if (!go.ok) return;
    if (go.checked) await makeRestorePoint(`SweepUninstall: before updating ${list.length} programs`, 'install');
    const results = [];
    for (const [i, u] of list.entries()) {
      setBusy(`Updating ${i + 1} of ${list.length}: ${u.name}…`);
      const r = await api.invoke('winget:upgrade', u.id).catch((e) => ({ ok: false, detail: e.message }));
      results.push({ kind: 'file', path: `${u.name} ${u.available}`, ok: r.ok, detail: r.detail });
    }
    setBusy('');
    setModal({ type: 'results', title: 'Update Report', results });
    load();
  };
  const exportWinget = async () => {
    setBusy('Exporting the program list with winget…');
    try {
      const out = await api.invoke('winget:export');
      if (out) setNotice({ tone: 'ok', text: `${out.packages} programs exported to ${out.file}. On another PC, run: winget import -i "${out.file.split('\\').pop()}"` });
    } catch (e) {
      setError(`winget could not export the list: ${e.message}`);
    } finally {
      setBusy('');
    }
  };
  const openMaintenance = async () => {
    setBusy('Reading the maintenance schedule…');
    try {
      const [s, status, cats] = await Promise.all([api.invoke('settings:get'), api.invoke('maintenance:status'), api.invoke('junk:scan').catch(() => [])]);
      const defaults = { enabled: false, day: 'Sunday', time: '10:00', snapshot: true, junk: ['usertemp', 'dumps', 'wer', 'thumbs', 'shaders'] };
      setModal({ type: 'maintenance', settings: { ...defaults, ...(s.maintenance || {}) }, status, categories: cats.map((c) => ({ id: c.id, label: c.label })) });
    } finally {
      setBusy('');
    }
  };

  const openGroupDialog = (list) => list.length && setModal({ type: 'group', programs: list });

  const saveGroup = async (list, group) => {
    setModal(null);
    try {
      await api.invoke('groups:set', { keys: list.map((p) => p.key), group, label: list.length === 1 ? list[0].name : undefined });
      setGroups(await api.invoke('groups:get'));
      const who = list.length === 1 ? list[0].name : `${list.length} programs`;
      setNotice({ tone: 'ok', text: group ? `${who} put in the group "${group}".` : `${who} taken out of ${list.length === 1 ? 'its group' : 'their groups'}.` });
    } catch (e) {
      setError(e.message);
    }
  };

  // ---- program backup and transfer -------------------------------------------

  const backupProgram = async (p) => {
    setBusy(`Finding ${p.name}'s files and settings…`);
    try {
      const items = await api.invoke('program:scan', p);
      const wanted = items.filter((i) => ['dir', 'file', 'key', 'value'].includes(i.kind));
      setModal({ type: 'backupProgram', program: p, items: wanted, settings: await api.invoke('transfer:classify', wanted) });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  };
  const saveProgramBackup = async (p, items, contents) => {
    const file = await api.invoke('transfer:pickSave', p);
    if (!file) return;
    setModal(null);
    setBusy(`Backing up ${p.name}…\nLarge programs can take a few minutes.`);
    try {
      const out = await api.invoke('transfer:export', { program: p, items, file, contents });
      const files = out.items.reduce((n, i) => n + (i.files || 0), 0);
      const skipped = out.items.reduce((n, i) => n + (i.skipped || 0), 0);
      const bytes = out.items.reduce((n, i) => n + (i.bytes || 0), 0);
      setNotice({ tone: skipped ? 'warn' : 'ok', text: `${p.name} backed up to ${out.file}: ${files.toLocaleString()} files (${formatBytes(bytes)}) and ${out.items.filter((i) => i.kind === 'key' || i.kind === 'value').length} registry entries.${skipped ? ` ${skipped} files in use were skipped; close the program and back up again to include them.` : ''}` });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  };
  const restoreProgramBackup = async () => {
    const file = await api.invoke('transfer:pickOpen');
    if (!file) return;
    setBusy('Reading the backup…');
    try {
      setModal({ type: 'restoreProgram', backup: await api.invoke('transfer:read', file) });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  };
  const runProgramRestore = async (backup, numbers) => {
    setModal(null);
    setBusy(`Restoring ${backup.program.name}…`);
    try {
      const out = await api.invoke('transfer:restore', { file: backup.file, numbers });
      const entry = (await api.invoke('history:list')).find((e) => e.undo?.channel === 'transfer:undo' && e.undo.arg === out.id);
      setModal({
        type: 'results',
        title: 'Restore Report',
        results: out.results,
        note: 'Undo removes what was restored and puts back any registry settings it changed. You can also undo it later from Tools › Change History.',
        ...(entry && { onUndo: () => runUndo(entry.id, entry.title) }),
      });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
      load();
    }
  };

  // ---- 1. uninstall queue --------------------------------------------------------------------

  const openQueue = async () => setModal({ type: 'queue', queue: await api.invoke('queue:get') });
  const queueAdd = async (list) => {
    const q = await api.invoke('queue:add', list.filter((p) => !p.store));
    setNotice({ tone: 'ok', text: `${list.length === 1 ? list[0].name : `${list.length} programs`} added to the uninstall queue (${q.programs.filter((p) => p.status === 'pending').length} waiting). Tools › Uninstall Queue starts it.` });
  };
  // Runs every waiting program; stops for a restart when an uninstaller asks for one.
  const runQueue = async () => {
    setModal(null);
    let q = await api.invoke('queue:get');
    if (!q) return;
    const go = await confirmWithRestore(`Uninstall ${q.programs.filter((p) => p.status === 'pending').length} programs from the queue?`, 'They run one after another, silently where possible. If one needs a restart, SweepUninstall asks, then continues after you sign back in. Leftovers are shown at the end.');
    if (!go.ok) return;
    if (go.checked) await makeRestorePoint('SweepUninstall: before the uninstall queue', 'uninstall');
    stopBatch.current = false;
    setBusyStop(() => () => {
      stopBatch.current = true;
    });
    try {
      for (const p of q.programs.filter((x) => x.status === 'pending')) {
        if (stopBatch.current) break;
        setBusy(`Uninstalling ${p.name}…`);
        const [info] = await Promise.all([api.invoke('program:prepare', p).catch(() => null)]);
        const r = await api.invoke('program:runUninstaller', p).catch((e) => ({ ok: false, error: e.message }));
        setBusy(`Scanning for leftovers of ${p.name}…`);
        const found = await api.invoke('program:scan', { ...p, installerItems: info?.installerItems || [] }).catch(() => []);
        p.status = r.ok || (r.code === 3010 || r.code === 1641) ? 'done' : 'failed';
        p.detail = r.error || (r.ok ? '' : `exit code ${r.code}`);
        q.leftovers.push(...found.map((i) => ({ ...i, program: p.name })));
        q = await api.invoke('queue:save', q);
        if (r.code === 3010 || r.code === 1641 || (await api.invoke('queue:restartPending'))) {
          q.restartNeeded = true;
          await api.invoke('queue:save', q);
          await api.invoke('queue:arm');
          setBusy('');
          setBusyStop(null);
          const now = await api.invoke('dialog:confirm', { message: `${p.name} needs a restart to finish.`, detail: 'Restart now? SweepUninstall continues the queue after you sign back in. Choose No to restart later yourself.' });
          if (now) await api.invoke('queue:restartNow');
          else setNotice({ tone: 'warn', text: 'The uninstall queue continues after your next restart.' });
          return;
        }
      }
    } finally {
      setBusy('');
      setBusyStop(null);
      load();
    }
    q = await api.invoke('queue:get');
    if (q.programs.some((p) => p.status === 'pending')) return setModal({ type: 'queue', queue: q });
    await api.invoke('queue:disarm');
    setModal({
      type: 'leftovers',
      title: `Uninstall Queue – ${q.programs.length} programs`,
      heading: `${q.programs.filter((p) => p.status === 'done').length} of ${q.programs.length} uninstalled. ${q.leftovers.length} leftover items found.`,
      items: q.leftovers,
      owners: q.programs.map((p) => p.key),
      onRemove: async (sel) => {
        if (await removeWithBackup('Uninstall queue', sel, q.programs.map((p) => p.location), q.programs.map((p) => p.key))) await api.invoke('queue:clear');
      },
    });
  };

  // ---- 2. removed outside SweepUninstall ------------------------------------------------------------

  const scanRemoved = async (list) => {
    setModal(null);
    const items = [];
    for (const [i, p] of list.entries()) {
      setBusy(`Scanning for leftovers (${i + 1} of ${list.length}): ${p.name}…`);
      items.push(...(await api.invoke('program:scan', { ...p, installerItems: [] }).catch(() => [])).map((x) => ({ ...x, program: p.name })));
    }
    setBusy('');
    setModal({ type: 'leftovers', title: 'Leftovers of Removed Programs', heading: `${items.length} leftover items of ${list.length} program${list.length === 1 ? '' : 's'} removed elsewhere.`, items, owners: list.map((p) => p.key), onRemove: (sel) => removeWithBackup('Leftovers of programs removed elsewhere', sel, null, list.map((p) => p.key)) });
  };

  // ---- 3. trial installs -----------------------------------------------------------------------

  const openTrials = async () => setModal({ type: 'trials', trials: await api.invoke('trials:list') });
  const newTrial = async () => {
    const installer = await api.invoke('monitor:pickInstaller');
    if (!installer) return;
    const name = installer.split('\\').pop().replace(/\.(exe|msi|msix|bat|cmd)$/i, '');
    setModal(null);
    setBusy(`Taking a snapshot before the trial of ${name}…`);
    try {
      await api.invoke('trials:start', { installer, name });
      await api.invoke('trials:launch', installer);
      setNotice({ tone: 'ok', text: `Trial of ${name} started. Install and try it; Tools › Trial Installs › Try Over removes it completely.` });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  };
  const tryOver = async (t) => {
    setModal(null);
    setBusy(`Comparing with the snapshot taken before ${t.name}…`);
    try {
      const r = await api.invoke('trials:tryOver', t.id);
      setModal({
        type: 'leftovers',
        title: `Try Over – ${t.name}`,
        heading: `${r.items.length} changes since the trial started (${r.added} added, ${r.changed} changed, ${r.removed} removed). Everything added is removed and changed settings are put back. Changes by other programs are listed too, so review before removing.`,
        items: r.items,
        owners: [],
        onRemove: async (sel) => {
          if (await removeWithBackup(`Try over: ${t.name}`, sel)) await api.invoke('trials:finish', t.id);
        },
      });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  };

  // ---- 4. rescue a broken uninstaller -------------------------------------------------------------------

  const rescue = async (p) => {
    setBusy(`Looking up ${p.name} in winget…`);
    let id = null;
    try {
      if (await api.invoke('winget:available')) id = await api.invoke('winget:find', p.name.replace(/\s+\(?(x64|x86|64-bit|32-bit)\)?$/i, '').replace(/\s+v?\d[\w.\-]*$/, ''));
    } finally {
      setBusy('');
    }
    if (!id) return setNotice({ tone: 'warn', text: `winget has no package for ${p.name}, so it can't be repaired that way. Use Force Removal instead.` });
    if (!(await api.invoke('dialog:confirm', { message: `Repair ${p.name}'s uninstaller?`, detail: `winget reinstalls the package "${id}" over the existing copy, which puts a working uninstaller back. Then the normal uninstall runs. Reinstalling accepts the package's license terms.` }))) return;
    setBusy(`Reinstalling ${id}…`);
    const r = await api.invoke('winget:repair', id).catch((e) => ({ ok: false, detail: e.message }));
    setBusy('');
    if (!r.ok) return setError(`winget could not reinstall ${id}: ${r.detail}. Use Force Removal instead.`);
    const fresh = (await api.invoke('programs:list', 'desktop')).find((x) => x.name === p.name || x.key === p.key);
    await load();
    if (fresh) actions.uninstall(fresh);
    else setNotice({ tone: 'warn', text: `${id} was reinstalled under a different name; uninstall it from the list.` });
  };

  // ---- 5-8. disk map, sheet, registry search ---------------------------------------------------------------

  const openDiskMap = async () => {
    setBusy('Measuring programs and their data folders…\nThis can take a minute.');
    try {
      setModal({ type: 'diskmap', data: await api.invoke('explore:diskMap', desktopCache.current) });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  };
  const openSheet = async (p) => {
    setModal(null);
    setBusy(`Finding everything ${p.name} hooks into Windows…`);
    try {
      setModal({ type: 'sheet', program: p, sections: await api.invoke('program:sheet', p) });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  };
  const searchRegistry = async (term) => {
    setModal(null);
    setBusy(`Searching the registry for "${term}"…`);
    try {
      const r = await api.invoke('registry:search', term);
      setModal({
        type: 'leftovers',
        title: `Registry Search – ${term}`,
        heading: `${r.items.length} keys and values${r.full ? ' (the first 400)' : ''}${r.timedOut ? ' found before the search time ran out' : ''}. Nothing is selected; Windows' own keys are never listed.`,
        items: r.items,
        owners: [],
        onRemove: (sel) => removeWithBackup(`Registry search: ${term}`, sel),
      });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  };

  // ---- 10. new startup entries; 18. notifications ---------------------------------------------------

  const notify = async (title, body) => {
    try {
      const n = await import('@tauri-apps/plugin-notification');
      if (!(await n.isPermissionGranted()) && (await n.requestPermission()) !== 'granted') return;
      n.sendNotification({ title, body });
    } catch {}
  };
  const checkStartup = async (quietIfNone = true) => {
    const found = await api.invoke('startup:newEntries').catch(() => []);
    if (!found.length) return !quietIfNone && setNotice({ tone: 'ok', text: 'No new startup entries.' });
    notify('New startup entry', `${found.map((e) => e.name).join(', ')} added ${found.length === 1 ? 'itself' : 'themselves'} to what starts with Windows.`);
    setModal((m) => m || { type: 'startupAlert', entries: found });
  };

  // ---- 11. browsers --------------------------------------------------------------------------------

  const openBrowsers = async () => {
    setBusy('Reading browser extensions…');
    try {
      const [data, running] = await Promise.all([api.invoke('browsers:list'), api.invoke('browsers:running')]);
      setModal({ type: 'browsers', data, running });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  };

  // ---- 13-14. whole-PC migration, folder restore, sync ---------------------------------------------------

  const packagePrograms = async (list, contents, folder, label) => {
    const done = [];
    for (const [i, p] of list.entries()) {
      setBusy(`${label} ${i + 1} of ${list.length}: ${p.name}…`);
      try {
        const items = (await api.invoke('program:scan', p)).filter((x) => ['dir', 'file', 'key', 'value'].includes(x.kind) && x.score >= 70);
        const name = `${String(p.name).replace(/[\\/:*?"<>|]+/g, ' ').trim()}.swpkg`;
        const out = await api.invoke('transfer:export', { program: p, items, file: `${folder}\\${name}`, contents });
        done.push({ kind: 'file', path: p.name, ok: true, detail: `${out.items.reduce((n, x) => n + (x.files || 0), 0)} files, ${out.items.filter((x) => x.kind === 'key' || x.kind === 'value').length} registry entries` });
      } catch (e) {
        done.push({ kind: 'file', path: p.name, ok: false, detail: e.message });
      }
    }
    return done;
  };
  const migratePc = async (list, mode) => {
    const folder = await api.invoke('transfer:pickFolder', 'Choose an empty folder for the migration');
    if (!folder) return;
    setModal(null);
    try {
      const results = await packagePrograms(list, mode, folder, 'Packaging');
      setBusy('Saving the winget list of all programs…');
      const w = (await api.invoke('winget:available')) ? await api.invoke('winget:exportTo', `${folder}\\all-programs.winget.json`).catch(() => null) : null;
      if (w) results.push({ kind: 'file', path: 'all-programs.winget.json', ok: true, detail: `${w.packages} programs for "winget import"` });
      setModal({ type: 'results', title: 'Migration Package', results, note: `Saved in ${folder}. On the new PC: File › Restore Programs From Folder, then winget import -i all-programs.winget.json for the rest.` });
    } finally {
      setBusy('');
    }
  };
  const restoreFolder = async () => {
    const folder = await api.invoke('transfer:pickFolder', 'Choose the folder with program packages');
    if (!folder) return;
    const packages = await api.invoke('transfer:folder', folder);
    if (!packages.length) return setNotice({ tone: 'warn', text: 'That folder has no program packages (.swpkg).' });
    setModal({ type: 'restoreFolder', folder, packages });
  };
  const restorePackages = async (packages, replace = false) => {
    setModal(null);
    const results = [];
    for (const [i, p] of packages.entries()) {
      setBusy(`Restoring ${i + 1} of ${packages.length}: ${p.name}…`);
      try {
        const b = await api.invoke('transfer:read', { file: p.file, replace });
        const out = await api.invoke('transfer:restore', { file: p.file, numbers: b.items.filter((x) => !x.blocked).map((x) => x.n), replace });
        const ok = out.results.filter((r) => r.ok).length;
        results.push({ kind: 'file', path: p.name, ok: ok > 0 || !out.results.length, detail: `${ok} of ${out.results.length} items restored` });
      } catch (e) {
        results.push({ kind: 'file', path: p.name, ok: false, detail: e.message });
      }
    }
    setBusy('');
    load();
    return results;
  };
  const openSync = async () => setModal({ type: 'sync', settings: await api.invoke('settings:get') });
  const syncPush = async (s) => {
    await api.invoke('settings:set', s);
    setModal(null);
    const list = desktopCache.current.filter((p) => s.syncKeys.includes(p.key));
    try {
      const results = await packagePrograms(list, 'settings', s.syncFolder, 'Sending settings');
      const lastPull = { ...((await api.invoke('settings:get')).lastPull || {}) };
      for (const p of await api.invoke('transfer:folder', s.syncFolder)) lastPull[p.name] = p.mtime; // our own copies don't need pulling back
      await api.invoke('settings:set', { lastPull });
      setModal({ type: 'results', title: 'Settings Sent', results, note: `Saved in ${s.syncFolder}.` });
    } finally {
      setBusy('');
    }
  };
  const syncPull = async (s) => {
    await api.invoke('settings:set', s);
    const lastPull = { ...((await api.invoke('settings:get')).lastPull || {}) };
    const newer = (await api.invoke('transfer:folder', s.syncFolder)).filter((p) => p.mtime > (lastPull[p.name] || 0));
    if (!newer.length) return setNotice({ tone: 'ok', text: 'Your settings are up to date.' });
    if (!(await api.invoke('dialog:confirm', { message: `Get newer settings for ${newer.length} program${newer.length === 1 ? '' : 's'}?`, detail: `${newer.map((p) => `• ${p.name}`).join('\n')}\n\nTheir current settings go to the Recycle Bin first, and each change can be undone from Change History. Close these programs first.` }))) return;
    const results = await restorePackages(newer, true);
    for (const p of newer) lastPull[p.name] = p.mtime;
    await api.invoke('settings:set', { lastPull });
    setModal({ type: 'results', title: 'Settings Received', results });
  };

  // ---- 15. portable apps --------------------------------------------------------------------------------

  const openPortable = async (extra = []) => {
    setBusy('Looking for portable apps…');
    try {
      setModal({ type: 'portable', apps: await api.invoke('portable:find', extra), extra });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  };

  // ---- 16. Explorer right-click requests (from the command line) -----------------------------------------------

  const uninstallTarget = async (target) => {
    const p = await api.invoke('shell:resolve', target);
    const lower = p.toLowerCase();
    const list = desktopCache.current.length ? desktopCache.current : await api.invoke('programs:list', 'desktop');
    const owner = list
      .map((x) => ({ x, loc: String(x.location || '').replace(/^"|"$/g, '').replace(/\\+$/, '').toLowerCase() }))
      .filter(({ loc }) => loc.length > 3 && (lower === loc || lower.startsWith(loc + '\\')))
      .sort((a, b) => b.loc.length - a.loc.length)[0]?.x;
    if (!owner) return setModal({ type: 'whoOwns', target: p });
    setView('desktop');
    setSelected(owner.key);
    setMarked(new Set([owner.key]));
    actions.uninstall(owner);
  };

  const actions = {
    backupProgram: (p) => view === 'desktop' && backupProgram(p),
    rescue: (p) => view === 'desktop' && rescue(p),
    sheet: (p) => view === 'desktop' && openSheet(p),
    compareNow: (p) => view === 'snapshots' && runCompare(p, null),
    deleteSnapshot: async (p) => {
      if (view !== 'snapshots') return;
      if (!(await api.invoke('dialog:confirm', { message: `Delete the snapshot "${p.name}"?`, detail: 'The snapshot file is deleted. Your files and settings are not affected.' }))) return;
      await api.invoke('snapshots:remove', p.id);
      load();
    },
    undoChange: async (p) => {
      if (view !== 'history') return;
      if (p.undone) return setNotice({ tone: 'warn', text: 'This change was already undone.' });
      if (!p.undo) {
        return setNotice({
          tone: 'warn',
          text: p.type === 'Uninstall' ? 'An uninstall cannot be undone here. Reinstall the program, or use the restore point made before it.' : 'This change cannot be undone here.',
        });
      }
      if (!(await api.invoke('dialog:confirm', { message: `Undo this change?`, detail: p.title }))) return;
      await runUndo(p.id, p.title);
    },
    uninstall: async (p) => {
      if (view === 'history') return actions.undoChange(p);
      if (view === 'archive') return actions.deleteRecord(p);
      if (p.portable) {
        if (!(await confirmWithRestore(`Remove the portable app ${p.name}?`, 'It has no uninstaller: SweepUninstall removes its folder, its entry and the files and settings it left, after you review them. Everything is backed up first.')).ok) return;
        return scanFor(p, `Remove Portable App – ${p.name}`, (items) => `SweepUninstall found ${items.length} items belonging to ${p.name}.`);
      }
      if (view === 'snapshots') return actions.deleteSnapshot(p);
      if (view === 'monitored') return uninstallMonitored(p);
      if (view === 'backups') return actions.deleteBackup(p);
      const prep = p.store ? null : await prepare([p]);
      const info = prep?.[0];
      const go = await confirmWithRestore(
        `Uninstall ${p.name}?`,
        (p.store ? 'The app package will be removed.' : "The program's own uninstaller will run first, then SweepUninstall scans for leftovers.") + (info ? prepNote(info) : '')
      );
      if (!go.ok) return;
      if (go.checked) await makeRestorePoint(`SweepUninstall: before uninstalling ${p.name}`, 'uninstall');
      setBusy(info && silentOn && info.installer.silent ? `Uninstalling ${p.name} silently…` : `Running the uninstaller for ${p.name}…\nFinish the uninstaller's window if one appears.`);
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
      await scanFor({ ...p, installerItems: info?.installerItems || [] }, `Uninstall – ${p.name}`, (items) =>
        result.error
          ? `${result.error} SweepUninstall found ${items.length} items.`
          : result.ok
            ? `Uninstall finished. SweepUninstall found ${items.length} leftover items.`
            : `The uninstaller exited with code ${result.code}. It may have been cancelled. SweepUninstall found ${items.length} items.`
      );
    },
    force: async (p) => {
      if (view !== 'desktop') return actions.uninstall(p);
      const [info] = await prepare([p]);
      const go = await confirmWithRestore(
        `Force removal of ${p.name}?`,
        "This skips the program's uninstaller and deletes its files and registry entries directly. Use it for programs whose uninstaller is broken or missing. Everything is backed up first." + prepNote(info, false)
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
        removeWithBackup(`${p.name} (entry)`, [{ kind: 'key', path: p.key, confidence: 'high', reason: 'Uninstall entry' }], null, [p.key]);
      }
    },
    registry: (p) => view === 'desktop' && api.invoke('program:openRegistry', p.key),
    folder: async (p) => {
      const r = await api.invoke('program:openFolder', p.location);
      if (r) setError(`${p.name}: install folder is unknown or missing.`);
    },
    search: (p) => api.invoke('program:search', p.name),
    properties: async (p) => {
      if (view === 'backups') return setModal({ type: 'results', title: `Backup – ${p.name}`, results: p.entries.map((e) => ({ ...e, ok: true, detail: e.kind === 'key' ? 'Exported .reg' : e.recycled ? 'In Recycle Bin' : '' })) });
      const sizes = view === 'desktop' ? (await api.invoke('programs:sizeHistory').catch(() => ({})))[p.key] : null;
      setModal({ type: 'properties', program: { ...p, insight: insight[p.key], sizes } });
    },
    reinstall: async (p) => {
      if (view !== 'archive') return;
      setBusy(`Looking up ${p.name} in winget…`);
      let id = p.wingetId;
      try {
        if (!id && (await api.invoke('winget:available'))) id = await api.invoke('winget:find', p.name.replace(/\s+\d[\w.\-]*$/, ''));
      } finally {
        setBusy('');
      }
      if (!id) return setNotice({ tone: 'warn', text: `winget has no package named "${p.name}".${p.url ? ' Use Publisher Website instead.' : ''}` });
      await api.invoke('archive:setPackage', { id: p.id, wingetId: id });
      if (!(await api.invoke('dialog:confirm', { message: `Reinstall ${p.name}?`, detail: `winget installs the package "${id}". Its installer may show its own window. Installing accepts the package's license terms.` }))) return;
      setBusy(`Installing ${id}…`);
      try {
        const r = await api.invoke('winget:install', id);
        setNotice({ tone: r.ok ? 'ok' : 'warn', text: r.ok ? `${p.name} was reinstalled.` : `winget could not install ${id}: ${r.detail}` });
      } finally {
        setBusy('');
      }
    },
    openSite: (p) => (p.url ? api.invoke('open:url', p.url).catch((e) => setError(e.message)) : setNotice({ tone: 'warn', text: 'No website was recorded for this program.' })),
    restoreRemoval: async (p) => {
      if (!p.backups?.length) return setNotice({ tone: 'warn', text: 'No removal backup is linked to this entry.' });
      if (!(await api.invoke('dialog:confirm', { message: `Put back what was removed for ${p.name}?`, detail: 'Its leftover files and settings are restored from the removal backup. This does not reinstall the program itself.' }))) return;
      setBusy('Restoring…');
      try {
        const results = (await Promise.all(p.backups.map((b) => api.invoke('backups:restore', b).catch((e) => [{ kind: 'file', path: b, ok: false, detail: e.message }])))).flat();
        setModal({ type: 'results', title: 'Restore Report', results });
      } finally {
        setBusy('');
      }
    },
    deleteRecord: async (p) => {
      if (!(await api.invoke('dialog:confirm', { message: `Delete ${p.name} from the archive?`, detail: 'Only this record is deleted. Backups stay in Tools › Backups.' }))) return;
      await api.invoke('archive:remove', p.id);
      load();
    },
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
    takeSnapshot: () => setModal({ type: 'takeSnapshot' }),
    restoreProgram: () => restoreProgramBackup(),
    queue: () => openQueue(),
    queueAdd: () => (view === 'desktop' || view === 'store') && (markedRows.length || current) && queueAdd(markedRows.length ? markedRows : [current]),
    trials: () => openTrials(),
    diskMap: () => openDiskMap(),
    regSearch: () => setModal({ type: 'regSearch' }),
    browsers: () => openBrowsers(),
    portable: () => openPortable(),
    migratePc: () => setModal({ type: 'migratePc' }),
    restoreFolder: () => restoreFolder(),
    sync: () => openSync(),
    report: () => setModal({ type: 'report' }),
    ctxmenu: async () => {
      setBusy('Reading Explorer’s right-click entries…');
      try {
        setModal({ type: 'ctxmenu', entries: await api.invoke('ctxmenu:list') });
      } catch (e) {
        setError(e.message);
      } finally {
        setBusy('');
      }
    },
    palette: () => setPalette(true),
    toggleTray: async () => {
      const s = await api.invoke('settings:set', { tray: !trayOn });
      setTrayOn(!!s.tray);
      await api.invoke('app:setTray', !!s.tray);
      setNotice({ tone: 'ok', text: s.tray ? 'SweepUninstall now stays in the tray when you close its window, and keeps checking for new startup entries. Exit from the tray menu.' : 'Closing the window exits SweepUninstall again.' });
    },
    toggleShell: async () => {
      try {
        setShellOn(await api.invoke(shellOn ? 'shell:disable' : 'shell:enable'));
        setNotice({ tone: 'ok', text: shellOn ? 'SweepUninstall was removed from Explorer’s right-click menu.' : 'Explorer’s right-click menu now has "Who owns this?" on files and folders, and "Uninstall with SweepUninstall" on shortcuts and programs (under Show more options on Windows 11).' });
      } catch (e) {
        setError(e.message);
      }
    },
    whoOwns: () => setModal({ type: 'whoOwns' }),
    orphans: () => findOrphans(),
    updates: () => setModal({ type: 'updates' }),
    exportWinget: () => exportWinget(),
    maintenance: () => openMaintenance(),
    compareSelected: () => {
      if (view !== 'snapshots' || markedRows.length !== 2) return setNotice({ tone: 'warn', text: 'Select exactly two snapshots (Ctrl+click) to compare them.' });
      runCompare(markedRows[0], markedRows[1]);
    },
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
    zoomIn: () => changeZoom(1),
    zoomOut: () => changeZoom(-1),
    zoomReset: () => changeZoom(0),
    toggleGrid: async () => {
      const s = await api.invoke('settings:set', { gridLines: !gridOn });
      setGridOn(s.gridLines !== false);
      setTheme(s.theme || 'dark');
      setTrayOn(!!s.tray);
      if (s.tray) api.invoke('app:setTray', true).catch(() => {});
    },
    toggleSafe: async () => {
      const s = await api.invoke('settings:set', { safeMode: !safeOn });
      setSafeOn(s.safeMode);
      setNotice({ tone: 'ok', text: s.safeMode ? 'Safe mode is on: leftover lists offer only items with a 90%+ match, and never services, scheduled tasks or firewall rules.' : 'Safe mode is off: every finding can be selected.' });
    },
    backupSettings: async () => setModal({ type: 'backupSettings', settings: await api.invoke('settings:get') }),
    openLog: () => api.invoke('log:open'),
    toggleSilent: async () => {
      const s = await api.invoke('settings:set', { silentUninstall: !silentOn });
      setSilentOn(s.silentUninstall);
      setNotice({ tone: 'ok', text: s.silentUninstall ? 'Silent uninstall is on: Windows Installer, Inno Setup, NSIS and WiX uninstallers run without their windows. Others run normally.' : 'Silent uninstall is off: every uninstaller shows its own window.' });
    },
    toggleRestore: async () => {
      const s = await api.invoke('settings:set', { createRestorePoints: !restoreOn });
      setRestoreOn(s.createRestorePoints);
      setSilentOn(!!s.silentUninstall);
      setSafeOn(!!s.safeMode);
      setGridOn(s.gridLines !== false);
      setTheme(s.theme || 'dark');
      setTrayOn(!!s.tray);
      if (s.tray) api.invoke('app:setTray', true).catch(() => {});
      api.invoke('backups:prune').catch(() => {});
      setNotice({ tone: 'ok', text: s.createRestorePoints ? 'Restore points are on: confirmations offer to create one first.' : 'Restore points are off: the checkbox starts unticked.' });
    },
  };

  const dispatch = (action) => {
    setMenu(null);
    if (action.startsWith('view:')) return setView(action.slice(5));
    if (action.startsWith('theme:')) {
      const th = action.slice(6);
      setTheme(th);
      return api.invoke('settings:set', { theme: th });
    }
    if (global[action]) return global[action]();
    if (busy || modal) return;
    if (action === 'clearSelection') return setMarked(new Set(current ? [current.key] : []));
    if (action === 'uninstall' && isBatch) return batchUninstall(markedRows);
    if (action === 'setGroup') return batchable && openGroupDialog(markedRows.length ? markedRows : [current].filter(Boolean));
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
      if (e.ctrlKey && !e.altKey && /^[1-9]$/.test(key)) action = `view:${['desktop', 'store', 'monitored', 'backups', 'debloat', 'startup', 'snapshots', 'junk', 'archive'][Number(key) - 1]}`;
      else if (e.ctrlKey && key === 'g') action = 'setGroup';
      else if (e.ctrlKey && key === 't') action = 'view:timeline';
      else if (e.ctrlKey && key === 'k') action = 'palette';
      else if (e.ctrlKey && key === 'q') action = 'queueAdd';
      else if (e.ctrlKey && key === 'w') action = 'sheet';
      else if (e.ctrlKey && key === 'f') action = 'find';
      else if (e.ctrlKey && key === 's') action = 'export';
      else if (e.ctrlKey && key === 'm') action = 'monitor';
      else if (e.ctrlKey && key === 'h') action = 'view:history';
      else if (e.ctrlKey && (key === '=' || key === '+')) action = 'zoomIn';
      else if (e.ctrlKey && key === '-') action = 'zoomOut';
      else if (e.ctrlKey && key === '0') action = 'zoomReset';
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
        // Sizes measured this session go into the size history once the measuring settles.
        clearTimeout(sizeTimer.current);
        sizeTimer.current = setTimeout(() => api.invoke('programs:recordSizes', desktopCache.current).catch(() => {}), 15000);
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
      if (multi) setMarked(new Set(visible.map((r) => r.key)));
      return;
    } else if (e.key.length === 1 && /\S/.test(e.key) && !e.ctrlKey && !e.altKey) {
      const ch = e.key.toLowerCase();
      const after = [...visible.slice(i + 1), ...visible.slice(0, i + 1)];
      const hit = after.find((r) => r.name.toLowerCase().startsWith(ch));
      if (hit) selectRow(hit.key);
      return;
    } else return;
    e.preventDefault();
    selectRow(visible[next].key, { shift: e.shiftKey && multi });
    listRef.current?.querySelector(`[data-idx="${next}"]`)?.scrollIntoView({ block: 'nearest' });
  };

  const contextItems = isBatch
    ? [['uninstall', `Uninstall ${markedRows.length} Programs...`, 'Del'], ['queueAdd', `Add ${markedRows.length} Programs to the Queue`, 'Ctrl+Q'], ['setGroup', `Set Group for ${markedRows.length} Programs...`, 'Ctrl+G'], null, ['clearSelection', 'Clear Selection']]
    : view === 'history'
      ? [['undoChange', 'Undo This Change', 'Del']]
    : view === 'archive'
      ? [['reinstall', 'Reinstall with winget...'], ['openSite', 'Publisher Website'], ['restoreRemoval', 'Put Back Removed Leftovers...'], null, ['deleteRecord', 'Delete From Archive', 'Del']]
    : view === 'snapshots'
      ? [['compareNow', 'Compare with Now'], ['compareSelected', 'Compare the Two Selected'], null, ['deleteSnapshot', 'Delete Snapshot', 'Del']]
    : view === 'backups'
      ? [['restore', 'Restore'], ['properties', 'Show Contents'], null, ['deleteBackup', 'Delete Backup']]
      : view === 'monitored'
        ? [['uninstall', 'Uninstall...'], null, ['properties', 'Recorded Changes'], ['search', 'Search Online']]
        : view === 'store'
          ? [['uninstall', 'Uninstall...'], ['setGroup', 'Set Group...', 'Ctrl+G'], null, ['folder', 'Installation Folder'], ['search', 'Search Online'], null, ['properties', 'Properties']]
          : [
              ['uninstall', 'Uninstall...', 'Del'],
              ['force', 'Force Removal...', 'Shift+Del'],
              ['analyze', 'Analyze Leftovers...', 'Ctrl+L'],
              ['removeEntry', 'Remove Entry...'],
              ['setGroup', 'Set Group...', 'Ctrl+G'],
              ['backupProgram', 'Migrate / Back Up Program...'],
              ['queueAdd', 'Add to Uninstall Queue', 'Ctrl+Q'],
              ['sheet', 'What It Does...', 'Ctrl+W'],
              ['rescue', 'Rescue Broken Uninstall...'],
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

  // Commands whose menu label contains what is typed in the search box.
  const cmdText = filter.trim().toLowerCase();
  const cmdSeen = new Set();
  const cmdMatches = cmdText.length < 2 ? [] : MENUS.flatMap(([menu, entries]) => entries.filter(Boolean).map(([action, label, accel]) => ({ action, label: label.replace(/\.\.\.$/, ''), accel, menu })))
      .filter((c) => c.label.toLowerCase().includes(cmdText) && !cmdSeen.has(c.action) && cmdSeen.add(c.action))
      .slice(0, 6);
  const cmdShown = cmdOpen && cmdMatches.length > 0;
  const runCmd = (c) => {
    setFilter('');
    setCmdIdx(-1);
    searchRef.current?.blur();
    setTimeout(() => dispatch(c.action), 0);
  };

  // The action bar: the main actions for the selection in the open list view.
  const barItems = isBatch
    ? contextItems.filter(Boolean)
    : view === 'desktop'
      ? DESKTOP_BAR.map((id) => contextItems.find((i) => i && i[0] === id)).filter(Boolean)
      : view === 'snapshots'
        ? [['takeSnapshot', 'Take Snapshot'], ...contextItems.filter(Boolean)]
        : contextItems.filter(Boolean);
  const barReady = (id) => (id === 'takeSnapshot' ? true : id === 'compareSelected' ? markedRows.length === 2 : isBatch || !!current);

  return (
    <div className={`app ${gridOn ? 'grid' : ''}`} onClick={() => menu && setMenu(null)}>
      <MenuBar onAction={dispatch} right={
          admin === false ? (
            <button className="link elevate" onClick={() => api.invoke('app:elevate')} title="Needed to remove programs installed for all users, and for machine-wide changes">
              Not elevated – Restart as Administrator
            </button>
          ) : admin ? (
            <span className="elevated">Administrator</span>
          ) : null
        }
        checked={{ toggleRestore: restoreOn, toggleSilent: silentOn, toggleSafe: safeOn, toggleGrid: gridOn, 'theme:dark': theme === 'dark', 'theme:light': theme === 'light', 'theme:contrast': theme === 'contrast', toggleTray: trayOn, toggleShell: shellOn }} />
      {/* Row 1: one box that searches the list and finds commands. */}
      <div className="cmdbar">
        <div className="search">
          <input
            ref={searchRef}
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setCmdIdx(-1);
              setCmdOpen(true);
            }}
            onFocus={() => setCmdOpen(true)}
            onBlur={() => setCmdOpen(false)}
            placeholder={`Search ${VIEWS[view].noun} or type a command, e.g. "cleaner" or "snapshot"`}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setFilter('');
                setCmdIdx(-1);
              } else if (cmdShown && e.key === 'ArrowDown') {
                e.preventDefault();
                setCmdIdx((i) => Math.min(cmdMatches.length - 1, i + 1));
              } else if (cmdShown && e.key === 'ArrowUp') {
                e.preventDefault();
                setCmdIdx((i) => Math.max(-1, i - 1));
              } else if (cmdShown && e.key === 'Enter' && cmdIdx >= 0) {
                e.preventDefault();
                runCmd(cmdMatches[cmdIdx]);
              }
            }}
            aria-label="Search or run a command"
            aria-expanded={cmdShown}
          />
          {filter && (
            <button className="clear" onClick={() => setFilter('')} aria-label="Clear search">
              ✕
            </button>
          )}
          {cmdShown && (
            <div className="cmd-list" role="listbox">
              <div className="cmd-head">Commands · ↓ to choose, Enter to run</div>
              {cmdMatches.map((c, i) => (
                <div key={c.action} role="option" aria-selected={i === cmdIdx} className={`cmd-item ${i === cmdIdx ? 'on' : ''}`} onMouseDown={(e) => (e.preventDefault(), runCmd(c))}>
                  <span>{c.label}</span>
                  <span className="cmd-where">{c.menu}{c.accel ? ` · ${c.accel}` : ''}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <button className="palette-hint" onClick={() => dispatch('palette')} title="Every command and program in one list">
          All commands <kbd>Ctrl+K</kbd>
        </button>
      </div>
      {/* Row 2: every view one click away, and the group filter. */}
      <div className="toolbar view-chips" role="toolbar" aria-label="Views">
        {VIEW_CHIPS.map(([id, label, title]) => (
          <button key={id} className={`view-chip ${view === id ? 'on' : ''}`} onClick={() => (VIEWS[id].button ? toggleView(id) : setView(id))} aria-pressed={view === id} title={title}>
            {label}
          </button>
        ))}
        <select
          className={`group-picker ${groupFilter !== ALL_GROUPS && batchable ? 'active' : ''}`}
          value={groupFilter}
          disabled={!batchable}
          onChange={(e) => setGroupFilter(e.target.value)}
          aria-label="Program group"
          title={batchable ? 'Show one group of programs. Right-click a program › Set Group to add it to one (Ctrl+G).' : 'Groups apply to the program lists'}
        >
          <option value={ALL_GROUPS}>All Groups</option>
          {groupNames.map((g) => (
            <option key={g} value={g}>
              {g} ({Object.values(groups).filter((x) => x === g).length})
            </option>
          ))}
          <option value={UNGROUPED}>Ungrouped</option>
          {view === 'desktop' && (
            <optgroup label="Insights">
              {INSIGHT_FILTERS.map(([id, label, test]) => (
                <option key={id} value={id}>
                  {label} ({rows.filter((r) => test(insight[r.key])).length})
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </div>
      {/* Row 3: what can be done with the selection, or what the open view is for. */}
      <div className="action-bar" role="toolbar" aria-label="Actions">
        {VIEW_NOTES[view] ? (
          <span className="action-note">{VIEW_NOTES[view]}</span>
        ) : (
          <>
            <span className={`action-subject ${current || isBatch ? '' : 'none'}`} title={current?.name}>
              {isBatch ? `${markedRows.length} selected:` : current ? `${current.name}:` : `Nothing selected`}
            </span>
            {barItems.map(([id, label]) => (
              <button key={id} className={`action-button ${/^(uninstall|force|delete)/i.test(id) ? 'danger' : ''}`} disabled={!barReady(id)} onClick={() => dispatch(id)}>
                {shortLabel(label)}
              </button>
            ))}
            {view === 'backups' && <span className="action-note right">Double-click a backup to restore it</span>}
            {view === 'history' && <span className="action-note right">Double-click a change to undo it</span>}
          </>
        )}
      </div>
      {view === 'snapshots' && !loading && (
        <SnapshotTimeline snapshots={rows.filter((r) => r.stats && r.created)} marked={marked} onSelect={(key, ctrl) => selectRow(key, { ctrl })} onCompare={(a, b) => runCompare(a, b)} onCompareNow={(s) => runCompare(s, null)} />
      )}

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
        <StartupView
          key={customKey}
          filter={filter}
          admin={admin}
          programs={desktopCache.current}
          onError={setError}
          onStatus={setCustomStatus}
          onRemoveRule={async (r) => {
            if (!(await api.invoke('dialog:confirm', { message: `Remove ${r.names.length === 1 ? 'the firewall rule' : `${r.names.length} firewall rules`} for "${r.display}"?`, detail: `${r.program} will no longer accept incoming connections through ${r.names.length === 1 ? 'this rule' : 'these rules'}. Each rule is backed up first and can be restored from Change History.` }))) return;
            removeWithBackup(`Firewall rules for ${r.display}`, r.names.map((n) => ({ kind: 'firewall', path: n, name: r.display, confidence: 'high', reason: 'Inbound rule' })));
          }}
        />
      ) : view === 'junk' ? (
        <JunkView key={customKey} filter={filter} admin={admin} onError={setError} onStatus={setCustomStatus} onClean={cleanJunk} />
      ) : (
      <div className={`list view-${view}`} tabIndex={0} ref={listRef} onKeyDown={onListKey}>
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
            {filter ? 'No matches.' : view === 'timeline' ? 'Nothing recorded yet.' : view === 'archive' ? 'No programs removed yet. Every program you uninstall is recorded here.' : view === 'monitored' ? 'No monitored programs yet. Use Tools › Monitor an Installation.' : view === 'backups' ? 'No backups yet.' : view === 'history' ? 'No changes yet. Everything SweepUninstall changes will be listed here.' : 'Nothing found.'}
          </div>
        ) : (
          visible.map((r, idx) => (
            <div
              key={r.key}
              data-idx={idx}
              className={`row ${marked.has(r.key) ? 'selected' : ''} ${r.key === selected ? 'focused' : ''} ${r.arch === 'user' ? 'user' : ''}`}
              onMouseDown={(e) => e.button === 0 && selectRow(r.key, { ctrl: multi && e.ctrlKey, shift: multi && e.shiftKey })}
              onDoubleClick={(e) => !e.ctrlKey && !e.shiftKey && dispatch(view === 'backups' ? 'restore' : view === 'history' ? 'undoChange' : view === 'snapshots' ? 'compareNow' : view === 'archive' ? 'reinstall' : 'uninstall')}
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
                  {id === 'name' && batchable && groups[r.key] && <span className="group-tag">{groups[r.key]}</span>}
                  {id === 'name' && view === 'desktop' && <InsightTags i={insight[r.key]} />}
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
      {modal?.type === 'leftovers' && (
        <LeftoversDialog
          {...modal}
          safeMode={safeOn}
          onDryRun={(sel) => api.invoke('backups:plan', { items: sel, owners: modal.owners || [] }).then((r) => r.results)}
          onExportPlan={(results) => api.invoke('export:html', { title: 'Export Dry Run', fileName: 'dry-run.html', html: planHtml(modal.title, results) })}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === 'interrupted' && (
        <InterruptedDialog
          pending={modal.pending}
          onChoose={async (action) => {
            setModal(null);
            setBusy(action === 'rollback' ? 'Rolling back the interrupted removal…' : action === 'finish' ? 'Finishing the interrupted removal…' : 'Saving…');
            try {
              const out = await api.invoke('backups:resolveInterrupted', action);
              if (out.results.length) setModal({ type: 'results', title: action === 'rollback' ? 'Rollback Report' : 'Removal Report', results: out.results });
            } catch (e) {
              setError(e.message);
            } finally {
              setBusy('');
              load();
            }
          }}
        />
      )}
      {modal?.type === 'backupSettings' && (
        <BackupSettingsDialog
          settings={modal.settings}
          onSave={async (patch) => {
            setModal(null);
            await api.invoke('settings:set', patch);
            const removed = await api.invoke('backups:prune');
            setNotice({ tone: 'ok', text: `Backup limits saved.${removed.length ? ` ${removed.length} old backup${removed.length === 1 ? ' was' : 's were'} removed.` : ''}` });
            if (view === 'backups') load();
          }}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === 'results' && <ResultsDialog {...modal} onClose={() => setModal(null)} />}
      {modal?.type === 'properties' && <PropertiesDialog program={modal.program} onClose={() => setModal(null)} />}
      {modal?.type === 'about' && <AboutDialog onClose={() => setModal(null)} />}
      {modal?.type === 'group' && (
        <GroupDialog programs={modal.programs} current={groups[modal.programs[0].key] || ''} grouped={modal.programs.some((p) => groups[p.key])} names={groupNames} onSave={(g) => saveGroup(modal.programs, g)} onClose={() => setModal(null)} />
      )}
      {modal?.type === 'whoOwns' && <WhoOwnsDialog initial={modal.target} onClose={() => setModal(null)} />}
      {modal?.type === 'queue' && (
        <QueueDialog
          queue={modal.queue}
          onStart={runQueue}
          onRemove={async (key) => setModal({ type: 'queue', queue: await api.invoke('queue:remove', key) })}
          onClear={async () => {
            await api.invoke('queue:clear');
            setModal({ type: 'queue', queue: null });
          }}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === 'outside' && <OutsideDialog programs={modal.programs} onScan={scanRemoved} onClose={() => setModal(null)} />}
      {modal?.type === 'trials' && (
        <TrialsDialog
          trials={modal.trials}
          onNew={newTrial}
          onTryOver={tryOver}
          onKeep={async (t) => {
            if (!(await api.invoke('dialog:confirm', { message: `Keep ${t.name}?`, detail: 'The trial ends and its snapshot is deleted. The program stays installed; you can still uninstall it normally later.' }))) return;
            await api.invoke('trials:finish', t.id);
            openTrials();
          }}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === 'diskmap' && (
        <DiskMapDialog
          data={modal.data}
          onSheet={(key) => {
            const p = desktopCache.current.find((x) => x.key === key);
            if (p) openSheet(p);
          }}
          onAnalyze={(key) => {
            const p = desktopCache.current.find((x) => x.key === key);
            setModal(null);
            if (p) scanFor(p, `Analysis – ${p.name}`, (items) => `${items.length} files, folders and registry entries are associated with ${p.name}.`);
          }}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === 'sheet' && (
        <SheetDialog
          {...modal}
          onAnalyze={() => {
            const p = modal.program;
            setModal(null);
            scanFor(p, `Analysis – ${p.name}`, (items) => `${items.length} files, folders and registry entries are associated with ${p.name}.`);
          }}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === 'regSearch' && (
        <PromptDialog
          title="Search Registry"
          heading="Find registry keys named after something, and values that mention it, in the software part of the registry."
          label="Search for"
          placeholder="e.g. a program or publisher name"
          action="Search"
          note="Results start unselected and go through the same protection rules as leftovers; anything removed is backed up first."
          onSubmit={searchRegistry}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === 'startupAlert' && (
        <StartupAlertDialog
          entries={modal.entries}
          onAllow={async (list) => {
            await api.invoke('startup:accept', list);
            const left = modal.entries.filter((e) => !list.some((x) => x.id === e.id));
            setModal(left.length ? { type: 'startupAlert', entries: left } : null);
          }}
          onDisable={async (e) => {
            try {
              await api.invoke('startup:set', { entry: e, enable: false });
              await api.invoke('startup:accept', [e]);
              const left = modal.entries.filter((x) => x.id !== e.id);
              setModal(left.length ? { type: 'startupAlert', entries: left } : null);
              setNotice({ tone: 'ok', text: `"${e.name}" no longer starts with Windows. Turn it back on in Startup & Services.` });
            } catch (err) {
              setError(err.message);
            }
          }}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === 'browsers' && (
        <BrowsersDialog
          {...modal}
          onRemove={async (list) => {
            if (!list.length) return;
            const items = list.flatMap((e) => e.removable);
            const owners = desktopCache.current
              .filter((p) => items.some((i) => (i.kind === 'dir' || i.kind === 'file') && p.location && i.path.toLowerCase().startsWith(String(p.location).replace(/\\+$/, '').toLowerCase() + '\\')))
              .map((p) => p.key);
            setModal(null);
            await removeWithBackup(`Browser extensions (${list.map((e) => e.name).join(', ')})`, items, null, owners);
          }}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === 'migratePc' && <MigratePcDialog programs={desktopCache.current} onSave={migratePc} onClose={() => setModal(null)} />}
      {modal?.type === 'restoreFolder' && (
        <FolderRestoreDialog
          {...modal}
          onRestore={async (list) => {
            const results = await restorePackages(list);
            setModal({ type: 'results', title: 'Restore Report', results, note: 'Each restore can be undone from Tools › Change History.' });
          }}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === 'sync' && (
        <SyncDialog
          settings={modal.settings}
          programs={desktopCache.current}
          onPickFolder={() => api.invoke('transfer:pickFolder', 'Choose the shared folder for settings sync')}
          onSave={async (s) => {
            await api.invoke('settings:set', s);
            setModal(null);
            setNotice({ tone: 'ok', text: 'Settings sync saved.' });
          }}
          onPush={syncPush}
          onPull={syncPull}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === 'portable' && (
        <PortableDialog
          apps={modal.apps}
          onRegister={async (a) => {
            try {
              await api.invoke('portable:register', a);
              setNotice({ tone: 'ok', text: `${a.name} is now in the program list.` });
              load();
              openPortable(modal.extra);
            } catch (e) {
              setError(e.message);
            }
          }}
          onUnregister={async (a) => {
            const p = desktopCache.current.find((x) => x.portable && String(x.location).toLowerCase() === a.folder.toLowerCase());
            if (p) await api.invoke('portable:unregister', p.key.replace(/^HKCU/, 'HKEY_CURRENT_USER')).catch((e) => setError(e.message));
            load();
            openPortable(modal.extra);
          }}
          onAddFolder={async () => {
            const f = await api.invoke('transfer:pickFolder', 'Choose a portable app’s folder');
            if (f) openPortable([...(modal.extra || []), f]);
          }}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === 'ctxmenu' && (
        <ContextMenuDialog
          entries={modal.entries}
          admin={admin}
          onToggle={async (e) => {
            if (e.admin && admin === false) return setError(`"${e.name}" needs administrator rights. Use File › Restart as Administrator.`);
            if (e.enabled && e.windows && !(await api.invoke('dialog:confirm', { message: `Turn off "${e.name}"?`, detail: 'This entry is part of Windows or a Microsoft product (such as the virus scan entry). Turning it off is reversible.' }))) return;
            try {
              const now = await api.invoke('ctxmenu:set', { entry: e, enable: !e.enabled });
              setModal((m) => m?.type === 'ctxmenu' ? { ...m, entries: m.entries.map((x) => (x.id === now.id ? now : x)) } : m);
            } catch (err) {
              setError(err.message);
            }
          }}
          onRestartExplorer={() => api.invoke('debloat:restartExplorer').catch((e) => setError(e.message))}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === 'report' && (
        <ReportDialog
          onMake={async (month) => {
            setModal(null);
            try {
              const html = await api.invoke('report:monthly', { month, programs: desktopCache.current, insight });
              await api.invoke('export:html', { title: 'Save Monthly Report', fileName: `sweepuninstall-report-${month}.html`, html });
            } catch (e) {
              setError(e.message);
            }
          }}
          onClose={() => setModal(null)}
        />
      )}
      {palette && (
        <CommandPalette
          commands={[
            ...MENUS.flatMap(([menuLabel, entries]) => entries.filter(Boolean).map(([action, label, accel]) => ({ id: `${menuLabel}|${action}|${label}`, text: `${label.replace(/\.\.\.$/, '')} (${menuLabel})`, hint: accel, action }))),
            ...desktopCache.current.map((p) => ({ id: `p|${p.key}`, text: `Program: ${p.name}`, program: p })),
          ]}
          onRun={(c) => {
            setPalette(false);
            if (c.program) {
              setView('desktop');
              setFilter('');
              setSelected(c.program.key);
              setMarked(new Set([c.program.key]));
              setTimeout(() => listRef.current?.querySelector('.row.focused')?.scrollIntoView({ block: 'center' }), 300);
            } else setTimeout(() => dispatch(c.action), 0);
          }}
          onClose={() => setPalette(false)}
        />
      )}
      {modal?.type === 'updates' && <UpdatesDialog onUpdate={runUpdates} onClose={() => setModal(null)} />}
      {modal?.type === 'maintenance' && (
        <MaintenanceDialog
          {...modal}
          onSave={async (m) => {
            setModal(null);
            try {
              const st = await api.invoke('maintenance:apply', m);
              setNotice({ tone: 'ok', text: st.registered ? `Weekly maintenance scheduled: ${m.day} at ${m.time}.` : 'Scheduled maintenance is off.' });
            } catch (e) {
              setError(/access is denied|0x80070005/i.test(e.message) ? 'Scheduling needs administrator rights. Use File › Restart as Administrator.' : e.message);
            }
          }}
          onRunNow={async () => {
            setModal(null);
            setBusy('Running maintenance…');
            try {
              const out = await api.invoke('maintenance:runNow');
              setModal({ type: 'results', title: 'Maintenance Report', results: out.lines.slice(2).map((l) => ({ kind: 'file', path: l, ok: !/failed/i.test(l), detail: '' })), note: `Saved to ${out.report}` });
            } catch (e) {
              setError(e.message);
            } finally {
              setBusy('');
            }
          }}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === 'backupProgram' && <ProgramBackupDialog {...modal} onSave={(items, contents) => saveProgramBackup(modal.program, items, contents)} onClose={() => setModal(null)} />}
      {modal?.type === 'restoreProgram' && <ProgramRestoreDialog backup={modal.backup} onRestore={(numbers) => runProgramRestore(modal.backup, numbers)} onClose={() => setModal(null)} />}
      {modal?.type === 'takeSnapshot' && <TakeSnapshotDialog onTake={takeSnapshot} onClose={() => setModal(null)} />}
      {modal?.type === 'compare' && (
        <ComparisonDialog
          {...modal}
          onClose={() => setModal(null)}
          onExport={(all) => api.invoke('export:html', { title: 'Export Comparison', fileName: 'snapshot-comparison.html', html: comparisonHtml(all, modal.beforeName, modal.afterName) })}
          onDryRun={async (chosen) => {
            const items = await api.invoke('snapshots:cleanupItems', { before: modal.comparison.beforeId, selected: chosen });
            return (await api.invoke('backups:plan', { items, owners: [] })).results;
          }}
          onExportPlan={(results) => api.invoke('export:html', { title: 'Export Dry Run', fileName: 'dry-run.html', html: planHtml(`Cleanup since ${modal.beforeName}`, results) })}
          onCleanup={(chosen) => {
            setModal(null);
            cleanupComparison(modal.comparison, modal.beforeName, chosen);
          }}
        />
      )}
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
