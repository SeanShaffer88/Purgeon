import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AboutDialog, Busy, ConfirmDialog, LeftoversDialog, MonitorWizard, PropertiesDialog, ResultsDialog, InterruptedDialog, BackupSettingsDialog, SystemInfoDialog, planHtml } from './dialogs.jsx';
import { WelcomeDialog, FirstRunTips, FIRST_RUN_TIPS, SettingHelp, SHORTCUTS, ShortcutsDialog, UpdateAvailableDialog, UserGuide } from './onboarding.jsx';
import { setConfirmUI } from './backend/api.js';
import { iconPathFor } from './backend/programs.js';
import { applyZoom, nextStep } from './zoom.js';
import { ACTION_TIPS, installTips } from './tips.js';
import * as updatecheck from './backend/updatecheck.js';
import { TakeSnapshotDialog, ComparisonDialog, SnapshotTimeline, comparisonHtml } from './snapshots.jsx';
import { DebloatView } from './debloat.jsx';
import { StartupView } from './startup.jsx';
import { JunkView, formatBytes } from './junk.jsx';
import { GroupDialog } from './groups.jsx';
import { ProgramBackupDialog, ProgramRestoreDialog } from './transfer.jsx';
import { WhoOwnsDialog, UpdatesDialog, MaintenanceDialog } from './tools.jsx';
import { QueueDialog, OutsideDialog, TrialsDialog, DiskMapDialog, SheetDialog, PromptDialog, StartupAlertDialog, BrowsersDialog, MigratePcDialog, FolderRestoreDialog, SyncDialog, PortableDialog, PortableAppsDialog, MakePortableDialog, TrustedPublishersDialog, UpdateCheckDialog, CommandPalette, ReportDialog, ContextMenuDialog, InstallerFoundDialog, AnalysisDialog, ProgramDetailDialog, ConfirmationSettingsDialog, ARCH_LABEL, CloseDialog } from './more.jsx';

const api = window.api;

// Starts background work (measuring, insights, the outside check) only once the
// list itself has had a chance to paint, so first paint is not competing with it.
const defer = (fn) => {
  if ('requestIdleCallback' in window) window.requestIdleCallback(fn, { timeout: 1200 });
  else setTimeout(fn, 400);
};

const VIEWS = {
  desktop: { label: 'Programs', noun: 'programs', cols: [['name', 'Name'], ['arch', 'Arch'], ['size', 'Size'], ['date', 'Installed On']] },
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

// Icons for the view bar on the left (18px, drawn with the text colour).
const VIEW_ICON_PATHS = {
  desktop: 'M3 4h14v10H3zM7 17h6M10 14v3',
  store: 'M4 7h12l-1 10H5zM7 7a3 3 0 0 1 6 0',
  monitored: 'M1.5 10s3-5.5 8.5-5.5S18.5 10 18.5 10 15.5 15.5 10 15.5 1.5 10 1.5 10zM10 7.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z',
  startup: 'M10 2.5v7M6.2 5.2a6 6 0 1 0 7.6 0',
  debloat: 'M4 3v14M10 3v14M16 3v14M2 7h4M8 13h4M14 9h4',
  junk: 'M4 6h12M8 6V4h4v2M5.5 6l1 11h7l1-11M8.5 9v5M11.5 9v5',
  snapshots: 'M3 6h3l1.5-2h5L14 6h3v10H3zM10 8.5a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  archive: 'M2.5 4h15v4h-15zM4 8v9h12V8M8 11h4',
  timeline: 'M10 2.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15zM10 6v4.5l3 2',
  backups: 'M10 2.5l6 2.5v5c0 4-2.5 6-6 7.5C6.5 16 4 14 4 10V5zM7.5 10l2 2 3.5-3.5',
  history: 'M3.5 10a6.5 6.5 0 1 1 2 4.6M3.5 10H7M3.5 10l.8-3.2M10 6.5V10l2.5 1.5',
};
const ViewIcon = ({ id }) => (
  <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
    <path d={VIEW_ICON_PATHS[id]} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// What the action bar says in views that have their own buttons.
const VIEW_NOTES = {
  startup: 'Startup & Services · turn entries off and on; nothing is deleted',
  debloat: 'Debloat · every tweak can be undone',
  junk: 'Cleaner · tick categories, then clean; files go to the Recycle Bin',
};

// The action bar's buttons for a desktop program, in order.
const DESKTOP_BAR = ['uninstall', 'force', 'analyzeProgram', 'analyze', 'sheet', 'backupProgram', 'queueAdd', 'setGroup', 'hide', 'unhide', 'folder', 'registry', 'search', 'properties'];
const shortLabel = (label) => label.replace(/\.\.\.$/, '').replace('Migrate / Back Up Program', 'Migrate').replace('Analyze Leftovers', 'Leftovers').replace(/^Analyze Program$/, 'Analyze').replace('Add to Uninstall Queue', 'Queue').replace('Compare the Two Selected', 'Compare Selected').replace(/^Set Group$/, 'Group').replace('Hide From List', 'Hide').replace('Installation Folder', 'Folder').replace('Registry Entry', 'Registry');

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

// Compact PC specs for the status bar: the processor name without its trademark
// marks and core-count suffix, and memory as a whole number of gigabytes.
const shortCpu = (cpu) => (cpu || '').replace(/\(R\)|\(TM\)|™/gi, '').replace(/\s+\d+-Core Processor/i, '').replace(/\s+Processor$/i, '').replace(/\s+/g, ' ').trim();
const ramTextOf = (bytes) => (bytes > 0 ? `${Math.round(bytes / 1073741824)} GB RAM` : '');

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

// Empty-state messages and actions for each view.
// Actions are passed in from the component so they can call setState.
const emptyStateMessage = (v, f) => {
  if (v === 'timeline') return 'Nothing recorded yet.';
  if (v === 'archive') return 'No programs removed yet. Every program you uninstall is recorded here.';
  if (v === 'monitored') return 'No monitored programs yet.';
  if (v === 'backups') return 'No backups yet.';
  if (v === 'history') return 'No changes yet. Everything Purgeon changes will be listed here.';
  if (v === 'desktop') return 'No programs found.';
  if (v === 'store') return 'No store apps found.';
  if (v === 'snapshots') return 'No snapshots yet.';
  if (f) return 'No matches.';
  return 'Nothing found.';
};

const emptyStateActions = (v, onMonitor, onSnapshot, onRefresh) => {
  const actions = [];
  if (v === 'monitored' && onMonitor)
    actions.push({ label: 'Monitor an Installation…', onClick: onMonitor, title: 'Start monitoring an installer' });
  if (v === 'backups' && onSnapshot)
    actions.push({ label: 'Take a Snapshot', onClick: onSnapshot, title: 'Take a new snapshot' });
  if ((v === 'desktop' || v === 'store') && onRefresh)
    actions.push({ label: 'Refresh List', onClick: onRefresh, title: 'Reload the program list from Windows' });
  return actions;
};

// What each menu holds, for the menu bar's tooltips.
const MENU_TIPS = {
  File: 'Export and reports, moving programs to another PC, settings sync, and restarting as administrator (Alt+F)',
  Action: 'What to do with the selected program: uninstall, force, leftovers, groups, hiding and more (Alt+A)',
  View: 'Which list to show, the disk space map, zoom, themes, and window and tray options (Alt+V)',
  Tools: 'Monitoring installations, snapshots, backups, clean-up tools and safety options (Alt+T)',
  Help: 'The command palette and information about Purgeon (Alt+H)',
};

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
      ['force', 'Force...', 'Shift+Del'],
      ['analyze', 'Analyze Leftovers...', 'Ctrl+L'],
      ['queueAdd', 'Add to Uninstall Queue', 'Ctrl+Q'],
      ['rescue', 'Rescue Broken Uninstall...'],
      ['removeEntry', 'Remove Entry...'],
      null,
      ['analyzeProgram', 'Analyze Program...', 'Ctrl+I'],
      ['sheet', 'What’s This...', 'Ctrl+W'],
      ['setGroup', 'Set Group...', 'Ctrl+G'],
      ['backupProgram', 'Migrate / Back Up Program...'],
      ['hide', 'Hide From List'],
      ['unhide', 'Unhide'],
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
      ['toggleHidden', 'Show Hidden Programs'],
      ['theme:dark', 'Dark Theme'],
      ['theme:light', 'Light Theme'],
      ['theme:contrast', 'High Contrast'],
      null,
      ['toggleOnTop', 'Always on Top'],
      ['toggleMinTray', 'Minimize to Tray'],
      ['close:ask', 'Close Button Asks'],
      ['close:tray', 'Close Button Hides to Tray'],
      ['close:exit', 'Close Button Exits'],
      ['toggleStartTray', 'Start Minimized to Tray'],
      ['toggleAutostart', 'Start with Windows'],
      null,
      ['schedule', 'Background Monitoring...'],
      ['syncFolder', 'Choose Sync Folder...'],
      null,
      ['language', 'Language...'],
    ],
  ],
  [
    'Tools',
    [
      ['monitor', 'Monitor an Installation...', 'Ctrl+M'],
      ['toggleDetect', 'Detect Installations'],
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
      ['sysinfo', 'System Info...'],
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
      ['confirmationPrompts', 'Confirmation Prompts...'],
      ['openLog', 'Open Command Log'],
      null,
      ['trustedPublishers', 'Trusted Publishers...'],
      ['updateCheck', 'Check for Updates...'],
      null,
      ['portableapps', 'PortableApps.com Installer...'],
    ],
  ],
  ['Help', [['palette', 'Command Palette...', 'Ctrl+K'], ['guide', 'User Guide'], ['shortcuts', 'Keyboard Shortcuts'], ['welcome', 'Welcome Back'], null, ['updates', 'Check for Updates...'], ['about', 'About']]],
];

// Mouse or keyboard: Alt plus a menu's first letter opens it; arrow keys move between items and
// menus, Enter chooses, Escape closes.
// Purgeon draws its own title bar (the menu bar), so it can hold the always-on-top pin.
const appWindow = () => import('@tauri-apps/api/window').then(({ getCurrentWindow }) => getCurrentWindow());

// The empty part of the title bar: drag to move the window, double-click to maximize or restore.
function TitleSpace() {
  return (
    <div
      className="title-space"
      title="Drag to move the window; double-click to maximize or restore it"
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        appWindow()
          .then((w) => (e.detail === 2 ? w.toggleMaximize() : w.startDragging()))
          .catch(() => {});
      }}
    >
      <span>Purgeon</span>
    </div>
  );
}

const PinIcon = ({ on }) => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" style={{ transform: on ? 'none' : 'rotate(45deg)' }}>
    <path d="M10.2 1.3 14.7 5.8 13.6 6.9 12.7 6.6 10 9.3 10.5 12.4 9.4 13.5 6.6 10.7 2.4 14.9 1.1 14.9 1.1 13.6 5.3 9.4 2.5 6.6 3.6 5.5 6.7 6 9.4 3.3 9.1 2.4Z" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
  </svg>
);

// Pin, minimize, maximize and close, in that order at the right end of the title bar.
function WindowControls({ pinned, onPin, toTray }) {
  const [max, setMax] = useState(false);
  useEffect(() => {
    let off = null;
    appWindow()
      .then(async (w) => {
        setMax(await w.isMaximized());
        off = await w.onResized(async () => setMax(await w.isMaximized()));
      })
      .catch(() => {});
    return () => off?.();
  }, []);
  const run = (fn) => () => appWindow().then(fn).catch(() => {});
  return (
    <div className="win-controls">
      <button
        className={`win-btn pin ${pinned ? 'on' : ''}`}
        onClick={onPin}
        aria-pressed={pinned}
        title={pinned ? 'Always on top is on: Purgeon stays in front of other windows. Click to turn it off.' : 'Always on top: keep Purgeon in front of other windows, even when you click elsewhere (View › Always on Top).'}
      >
        <PinIcon on={pinned} />
      </button>
      <button className="win-btn glyph" onClick={toTray ? () => api.invoke('app:hideToTray') : run((w) => w.minimize())} title={toTray ? 'Minimize to the tray: the window and its taskbar button go away; left-click the tray icon to bring it back (View › Minimize to Tray)' : 'Minimize to the taskbar (View › Minimize to Tray sends it to the tray instead)'} aria-label="Minimize">
        {''}
      </button>
      <button className="win-btn glyph" onClick={run((w) => w.toggleMaximize())} title={max ? 'Restore the window to its earlier size' : 'Maximize the window'} aria-label={max ? 'Restore' : 'Maximize'}>
        {max ? '' : ''}
      </button>
      <button className="win-btn glyph close" onClick={run((w) => w.close())} title="Close Purgeon (it keeps running in the tray with View › Close to Tray)" aria-label="Close">
        {''}
      </button>
    </div>
  );
}

function MenuBar({ onAction, checked = {}, right = null, controls = null, menus = MENUS }) {
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
        const i = menus.findIndex(([label]) => label[0].toLowerCase() === e.key.toLowerCase());
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
      setOpen((i + (e.key === 'ArrowRight' ? 1 : menus.length - 1)) % menus.length);
      setTimeout(() => focusItem(1), 0);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setOpen(null);
    }
  };
  return (
    <div className="menubar" role="menubar" ref={bar} onMouseDown={(e) => e.stopPropagation()}>
      {menus.map(([label, entries], i) => (
        <div key={label} className="menubar-item">
          <button
            className={open === i ? 'open' : ''}
            aria-haspopup="menu"
            aria-expanded={open === i}
            title={MENU_TIPS[label]}
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
                    title={ACTION_TIPS[it[0]]}
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
      <TitleSpace />
      {right && <div className="menubar-right">{right}</div>}
      {controls}
    </div>
  );
}

export default function App() {
  const [view, setView] = useState('desktop');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [quickFilter, setQuickFilter] = useState('all');
  const [sort, setSort] = useState({ col: 'name', dir: 1 });
  const [selected, setSelected] = useState(null);
  const [icons, setIcons] = useState({});
  const [admin, setAdmin] = useState(null);
  const [specs, setSpecs] = useState(null);
  const [modal, setModal] = useState(null);
const [busy, setBusy] = useState(null); // { message, progress, current, total, canPause, canCancel, onPause, onCancel }
const [menu, setMenu] = useState(null);
  // Multi-selection (keys); `selected` is the focused row and the range anchor moves with plain clicks.
  const [marked, setMarked] = useState(() => new Set());
  const anchor = useRef(null);
  const [busyStop, setBusyStop] = useState(null);
  const stopBatch = useRef(false);
  const [notice, setNotice] = useState(null);
// Undo toast: last removal/change can be undone within 30 seconds.
const [undoStack, setUndoStack] = useState([]);
const undoTimerRef = useRef(null);
// View history for back/forward navigation.
const [viewHistory, setViewHistory] = useState([]);
const [historyIdx, setHistoryIdx] = useState(-1);
// Recently viewed/acted-on programs (most recent first, max 10).
const [recentPrograms, setRecentPrograms] = useState([]);

// View history for back/forward navigation.
useEffect(() => {
  setViewHistory((prev) => {
    const next = [...prev.slice(0, historyIdx + 1), view];
    if (next.length > 50) next.shift();
    return next;
  });
  setHistoryIdx((prev) => prev + 1);
}, [view, historyIdx]);

// Go back in view history.
const goBack = useCallback(() => {
  if (historyIdx > 0) {
    setHistoryIdx((i) => i - 1);
    setView(viewHistory[i - 1]);
  }
}, [historyIdx, viewHistory]);

// Go forward in view history.
const goForward = useCallback(() => {
  if (historyIdx < viewHistory.length - 1) {
    setHistoryIdx((i) => i + 1);
    setView(viewHistory[i + 1]);
  }
}, [historyIdx, viewHistory]);

// Add a program to recent programs.
const addRecent = useCallback((program) => {
  setRecentPrograms((prev) => {
    const filtered = prev.filter((p) => p.key !== program.key);
    return [program, ...filtered].slice(0, 10);
  });
}, []);

  const [restoreOn, setRestoreOn] = useState(true);
  const [silentOn, setSilentOn] = useState(false);
  const [safeOn, setSafeOn] = useState(false);
  const [gridOn, setGridOn] = useState(true);
  const [theme, setTheme] = useState('dark');
  const [lang, setLang] = useState('en');
  const [syncOn, setSyncOn] = useState(false);
  const [syncFolder, setSyncFolder] = useState('');
  const [scheduleOn, setScheduleOn] = useState(false);
  // What the close button does: 'ask', 'tray' (keep running in the tray) or 'exit'.
const [closeAction, setCloseAction] = useState('ask');
const [closeAsk, setCloseAsk] = useState(false);
// First-run onboarding state.
const [hasSeenWelcome, setHasSeenWelcome] = useState(null); // null = not yet loaded from settings
const [welcomeOpen, setWelcomeOpen] = useState(false);
const [updateShown, setUpdateShown] = useState(false);
const [firstRunTipDismissed, setFirstRunTipDismissed] = useState(() => new Set());
const [tipsActive, setTipsActive] = useState(false);
  // Window options (View menu); Start with Windows is read from Task Scheduler.
  const [win, setWin] = useState({ alwaysOnTop: false, minimizeToTray: false, startInTray: false });
  const [autostartOn, setAutostartOn] = useState(false);
  const [detectOn, setDetectOn] = useState(true);
  // Programs hidden from the lists ({ programKey: name }); View › Show Hidden Programs shows them dimmed.
  const [hidden, setHidden] = useState({});
  const [showHidden, setShowHidden] = useState(false);
  const [shellOn, setShellOn] = useState(false);
  const [palette, setPalette] = useState(false);
  const outsideChecked = useRef(false);
const [zoom, setZoom] = useState(1);
const [textScale, setTextScale] = useState(1);
const [reducedMotion, setReducedMotion] = useState(false);
// Program groups ({ programKey: group }) and the group the program lists are filtered to.
  const [groups, setGroups] = useState({});
  const [groupFilter, setGroupFilter] = useState(ALL_GROUPS);
  // Per-program insights (signature, installed together, offers, growth), loaded after the list.
  const [insight, setInsight] = useState({});
  const sizeTimer = useRef(null);
  // Measured sizes/dates waiting to be applied to the list (see the onMeasured effect).
  const measuredPending = useRef(new Map());
  const measuredTimer = useRef(null);
  const groupNames = useMemo(() => [...new Set(Object.values(groups))].sort((a, b) => a.localeCompare(b)), [groups]);
  const debloatGatePassed = useRef(false);
  const searchRef = useRef(null);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [cmdIdx, setCmdIdx] = useState(-1);
  const listRef = useRef(null);
  const actionBarRef = useRef(null);
  const [actionBarW, setActionBarW] = useState(0);
  // Keep the action bar's width measured so its buttons can be laid out in balanced rows.
  // The bar element is re-created when the view changes (each view has its own actions),
  // so this re-runs per view and measures the bar actually on screen. A width of 0 (the
  // old bar, detached) must never overwrite a real measurement: with no measured width
  // the layout falls back to every action in one squeezed row.
  useEffect(() => {
    const el = actionBarRef.current;
    if (!el) return undefined;
    const update = () => {
      const w = el.clientWidth;
      if (w > 0) setActionBarW((prev) => (prev === w ? prev : w));
    };
    update();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [view]);
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
        defer(() => {
          api.invoke('programs:measure', data).catch(() => {});
          api.invoke('programs:insights', data).then(setInsight).catch(() => {});
        });
        if (!outsideChecked.current) {
          outsideChecked.current = true;
          defer(() => {
            api.invoke('programs:outside', data).then((gone) => gone.length && setModal((m) => m || { type: 'outside', programs: gone })).catch(() => {});
          });
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
    api.invoke('app:specs').then(setSpecs).catch(() => {});
    api.invoke('settings:get').then((s) => {
      setRestoreOn(s.createRestorePoints);
      setSilentOn(!!s.silentUninstall);
      setSafeOn(!!s.safeMode);
      setGridOn(s.gridLines !== false);
      setTheme(s.theme || 'dark');
      setLang(s.language || 'en');
      setSyncOn(!!s.syncOn);
      setSyncFolder(s.syncFolder || '');
      setHasSeenWelcome(!!s.hasSeenWelcome);
      applyWindow(s);
      api.invoke('backups:prune').catch(() => {});
      setZoom(s.zoom || 1);
      applyZoom(s.zoom || 1);
      setTextScale(s.textScale || 1);
      setReducedMotion(!!s.reducedMotion);
      // Update notification: checked once on startup, never nagging.
      updatecheck.check().then(({ enabled, update, error }) => {
        if (enabled && update && update.newer && !updateShown) {
          setUpdateShown(true);
          setModal({ type: 'updateAvailable', version: update.version });
        }
      }).catch(() => {});
    });
    api.invoke('schedule:status').then((s) => s && setScheduleOn(!!s.registered)).catch(() => {});
    api.invoke('monitor:status').then((s) => s && setModal({ type: 'monitor', resume: s }));
    // A removal cut off by a crash or power cut comes first.
    api.invoke('backups:interrupted').then((p) => p && setModal({ type: 'interrupted', pending: p })).catch(() => {});
    api.invoke('groups:get').then(setGroups).catch(() => {});
    api.invoke('shell:enabled').then(setShellOn).catch(() => {});
    api.invoke('autostart:enabled').then(setAutostartOn).catch(() => {});
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
    // New startup entries: checked now and every 10 minutes while Purgeon runs (also from the tray).
    const first = setTimeout(() => checkStartup(), 8000);
    const every = setInterval(() => checkStartup(), 10 * 60 * 1000);
    // The page is alive and about to listen for the close question: from here on the
    // native side may intercept a close and ask; before this it must let it through.
    api.invoke('app:ready').catch(() => {});
    // Tray menu choices.
    let unlisten = null;
    let unlistenClose = null;
    import('@tauri-apps/api/event')
      .then(({ listen }) => listen('close-requested', () => setCloseAsk(true)))
      .then((u) => (unlistenClose = u))
      .catch(() => {});
    import('@tauri-apps/api/event')
      .then(({ listen }) => listen('tray', (e) => (e.payload === 'junk' ? setView('junk') : e.payload === 'startup' ? setView('startup') : e.payload === 'updates' ? setModal({ type: 'updates' }) : e.payload === 'monitor' ? setModal((m) => m || { type: 'monitor' }) : null)))
      .then((u) => (unlisten = u))
      .catch(() => {});
    return () => {
      clearTimeout(first);
      clearInterval(every);
      unlisten?.();
      unlistenClose?.();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // Show the welcome dialog on first launch, after settings are loaded.
    useEffect(() => {
      if (hasSeenWelcome === null) return; // settings not loaded yet
      if (!hasSeenWelcome) {
        setWelcomeOpen(true);
      }
    }, [hasSeenWelcome]);

    // Store the welcome-seen flag so it doesn't show again.
    const markWelcomeSeen = useCallback(async () => {
      await api.invoke('settings:set', { hasSeenWelcome: true }).catch(() => {});
      setHasSeenWelcome(true);
    }, []);

    // The theme lives on the root element so dialogs and menus follow it too.
    useEffect(() => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.style.setProperty('--text-scale', textScale);
      document.documentElement.dataset.reducedMotion = reducedMotion;
    }, [theme, textScale, reducedMotion]);

  // Icons arrive in one batch after the list is shown; programs without one keep a placeholder.
  useEffect(() => {
    if (view !== 'desktop') return;
    let cancelled = false;
    const missing = rows.filter((r) => !(r.key in icons));
    if (!missing.length) return;
    api
      .invoke('icons:get', missing)
      .then((found) => {
        if (!cancelled) setIcons((m) => ({ ...m, ...Object.fromEntries(missing.map((r) => [r.key, found?.[r.key] || null])) }));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps

  // A program's architecture: from its program file when known, otherwise from where Windows lists it.
  const archOf = (r) => {
    const a = insight[r.key]?.arch;
    if (a) return { text: { x64: '64-bit', x86: '32-bit', arm64: 'ARM64', arm: 'ARM' }[a] || a, how: `${ARCH_LABEL[a] || a}, read from its program file ${insight[r.key].exe}.${a === 'x86' ? ' (.NET programs built for “Any CPU” show as 32-bit but run as 64-bit.)' : ''}` };
    if (r.arch === 'x86') return { text: '32-bit', how: 'Listed in the 32-bit part of the registry (WOW6432Node); its program file could not be checked.' };
    if (r.arch === 'x64') return { text: '64-bit', how: 'Listed in the 64-bit part of the registry; its program file could not be checked.' };
    return { text: '', how: 'Installed for your user only; its program file could not be checked.' };
  };
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const programs = view === 'desktop' || view === 'store';
    const insightFilter = INSIGHT_FILTERS.find(([id]) => id === groupFilter);
    const inGroup = (r) =>
      !programs || groupFilter === ALL_GROUPS || (insightFilter ? !!insightFilter[2](insight[r.key]) : groupFilter === UNGROUPED ? !groups[r.key] : groups[r.key] === groupFilter);
    const shown = (r) => !programs || showHidden || !hidden[r.key];
    const thirtyDaysAgo = Date.now() - 30 * 86400000;
    const list = rows.filter((r) => {
      if (!shown(r) || !inGroup(r)) return false;
      if (q && !`${r.name} ${r.publisher || ''} ${(programs && groups[r.key]) || ''}`.toLowerCase().includes(q)) return false;
      if (quickFilter !== 'all') {
        if (quickFilter === 'desktop' && r.store) return false;
        if (quickFilter === 'store' && !r.store) return false;
        if (quickFilter === 'recent') {
          const d = r.date ? new Date(r.date).getTime() : 0;
          if (!d || d < thirtyDaysAgo) return false;
        }
        if (quickFilter === 'large') {
          const kb = r.sizeKB || r.sortSize || 0;
          if (kb < 100 * 1024) return false;
        }
        if (quickFilter === 'unsigned') {
          const sig = insight[r.key]?.signature;
          if (!sig || sig === 'Valid') return false;
        }
        if (quickFilter === 'used') {
          const t = insight[r.key]?.written;
          if (!t || new Date(t).getTime() < thirtyDaysAgo) return false;
        }
      }
      return true;
    });
    const val = (r) => (sort.col === 'size' ? r.sortSize : sort.col === 'arch' ? archOf(r).text : sort.col === 'date' && r.sortDate ? r.sortDate : sort.col === 'used' ? (insight[r.key]?.written || '').toString().toLowerCase() : (r[sort.col] || '').toString().toLowerCase());
    return [...list].sort((a, b) => {
      const x = val(a);
      const y = val(b);
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
    });
  }, [rows, filter, sort, groups, groupFilter, view, insight, hidden, showHidden]);
  const hiddenCount = view === 'desktop' || view === 'store' ? rows.filter((r) => hidden[r.key]).length : 0;

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
      setSelected(key);
    } else if (ctrl) {
      setMarked((m) => {
        const n = new Set(m);
        n.has(key) ? n.delete(key) : n.add(key);
        return n;
      });
      anchor.current = key;
      setSelected(key);
    } else {
      // Clicking the same already-selected row again deselects it.
      if (marked.size === 1 && marked.has(key)) {
        setMarked(new Set());
        setSelected(null);
        anchor.current = null;
      } else {
        const program = visible.find((r) => r.key === key);
        if (program) addRecent(program);
        setMarked(new Set([key]));
        anchor.current = key;
        setSelected(key);
      }
    }
  };

  // ---- restore points ------------------------------------------------------

  const confirmWithRestore = (message, detail, confirmId) =>
    api.invoke('dialog:confirm', { message, detail, confirmId, checkboxLabel: 'Create a restore point first', checkboxChecked: restoreOn });

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
    const r = await confirmWithRestore('Change Windows settings?', `Purgeon will apply "${title}". This question appears only before your first debloat change of this session.`, 'confirmDebloat');
    if (!r.ok) return false;
    if (r.checked) await makeRestorePoint('Purgeon: before Windows debloat changes', 'settings');
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
          confirmId: 'closeRunningPrograms',
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
        if (/^Force – /.test(title) && sel.some((i) => i.kind === 'key' && i.path.toLowerCase().endsWith(p.key.split('\\').pop().toLowerCase()))) {
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
    const run = registered && (await confirmWithRestore(`Run ${registered.name}'s own uninstaller first?`, 'Recommended. Afterwards Purgeon removes everything else the installation created.', 'confirmRunUninstaller'));
    if (run?.ok) {
      if (run.checked) await makeRestorePoint(`Purgeon: before uninstalling ${registered.name}`, 'uninstall');
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
      const tags = [info?.installer.label, silentOn && info?.installer.silent ? 'silent' : '', info?.dependencies?.kind === 'runtime' ? '\u26a0 shared runtime' : info?.dependencies?.kind === 'driver' ? '\u26a0 driver' : '', info?.dependencies?.dependents?.length ? `\u26a0 needed by ${info.dependencies.dependents.join(', ')}` : ''].filter(Boolean);
      return `\u2022 ${p.name}${tags.length ? `  (${tags.join(', ')})` : ''}`;
    };
    const go = await confirmWithRestore(
      `Uninstall ${list.length} programs?`,
      `${list.map(line).join('\n')}\n\nEach program's own uninstaller runs in turn${silentOn ? '; ones marked silent run without their windows' : ', so finish each uninstaller\'s window'}. Afterwards Purgeon scans all of them for leftovers.`,
      'confirmBatchUninstall'
    );
    if (!go.ok) return;
    if (go.checked) await makeRestorePoint(`Purgeon: before uninstalling ${list.length} programs`, 'uninstall');

    stopBatch.current = false;
    pausedBatch.current = false;
    setBusyStop(() => () => {
      stopBatch.current = true;
    });
    const outcomes = [];
    for (const [i, p] of list.entries()) {
      if (stopBatch.current) {
        outcomes.push({ p, skipped: true });
        continue;
      }
      while (pausedBatch.current) {
        await new Promise((r) => setTimeout(r, 200));
        if (stopBatch.current) break;
      }
      if (stopBatch.current) {
        outcomes.push({ p, skipped: true });
        continue;
      }
      setBusy({ message: `Uninstalling ${i + 1} of ${list.length}: ${p.name}`, current: i + 1, total: list.length, canPause: true, canCancel: true, onPause: (paused) => { pausedBatch.current = paused; }, onCancel: () => { stopBatch.current = true; } });
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
      if (stopBatch.current) break;
      while (pausedBatch.current) {
        await new Promise((r) => setTimeout(r, 200));
        if (stopBatch.current) break;
      }
      if (stopBatch.current) break;
      setBusy({ message: `Scanning for leftovers of ${p.name}`, current: i + 1, total: ran.length, canPause: true, canCancel: true, onPause: (paused) => { pausedBatch.current = paused; }, onCancel: () => { stopBatch.current = true; } });
      const found = await api.invoke('program:scan', { ...p, installerItems: infoFor(p)?.installerItems || [] }).catch(() => []);
      items.push(...found.map((it) => ({ ...it, program: p.name })));
    }
    setBusy('');
    load();

    const ok = outcomes.filter((o) => o.result?.ok).length;
    const problems = outcomes
      .filter((o) => !o.result?.ok)
      .map((o) => (o.skipped ? `${o.p.name}: skipped` : o.result.error ? `${o.p.name}: ${o.result.error}` : `${o.p.name}: uninstaller exited with code ${o.result.code}`));
    const heading = `Uninstalled ${ok} of ${list.length} programs.${problems.length ? ` ${problems.join('; ')}.` : ''} Purgeon found ${items.length} leftover items.`;
    setModal({
      type: 'leftovers',
      title: `Batch Uninstall \u2013 ${list.length} programs`,
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
      'Added items are removed, and changed or removed registry values and keys are put back from the earlier snapshot. Everything is backed up first and can be undone.',
      'confirmSnapshotCleanup'
    );
    if (!go.ok) return;
    if (go.checked) await makeRestorePoint(`Purgeon: before cleaning up changes since ${beforeName}`, 'settings');
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
        confirmId: 'cleanJunk',
        message: `Clean ${formatBytes(bytes)} of junk files?`,
        detail: `${categories.map((c) => `• ${c.label}: ${formatBytes(c.bytes)}`).join('\n')}\n\n${items.length.toLocaleString()} items go to the Recycle Bin. You can undo this from Tools › Change History until the Recycle Bin is emptied.`,
      });
      if (!ok) return;
      await removeWithBackup(`Junk files (${categories.map((c) => c.label).join(', ')})`, items);
    }
    if (!system.length) return;
    // Windows' own clean-ups are permanent, so they get their own, explicit confirmation.
    const go = await api.invoke('dialog:confirm', {
      confirmId: 'cleanSystemWindows',
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
    const go = await confirmWithRestore(`Update ${list.length} program${list.length === 1 ? '' : 's'}?`, `${list.map((u) => `• ${u.name}: ${u.version} → ${u.available}`).join('\n')}\n\nwinget updates them one after another, silently.`, 'confirmUpdate');
    if (!go.ok) return;
    if (go.checked) await makeRestorePoint(`Purgeon: before updating ${list.length} programs`, 'install');
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
    const go = await confirmWithRestore(`Uninstall ${q.programs.filter((p) => p.status === 'pending').length} programs from the queue?`, 'They run one after another, silently where possible. If one needs a restart, Purgeon asks, then continues after you sign back in. Leftovers are shown at the end.', 'confirmQueueUninstall');
    if (!go.ok) return;
    if (go.checked) await makeRestorePoint('Purgeon: before the uninstall queue', 'uninstall');
    stopBatch.current = false;
    setBusyStop(() => () => {
      stopBatch.current = true;
    });
    try {
      const pending = q.programs.filter((x) => x.status === 'pending');
      for (const [i, p] of pending.entries()) {
        if (stopBatch.current) break;
        setBusy({ message: `Uninstalling ${p.name}`, current: i + 1, total: pending.length, canCancel: true, onCancel: () => { stopBatch.current = true; } });
        const [info] = await Promise.all([api.invoke('program:prepare', p).catch(() => null)]);
        const r = await api.invoke('program:runUninstaller', p).catch((e) => ({ ok: false, error: e.message }));
        setBusy({ message: `Scanning for leftovers of ${p.name}`, current: i + 1, total: pending.length, canCancel: true, onCancel: () => { stopBatch.current = true; } });
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
          const now = await api.invoke('dialog:confirm', { confirmId: 'queueRestart', message: `${p.name} needs a restart to finish.`, detail: 'Restart now? Purgeon continues the queue after you sign back in. Choose No to restart later yourself.' });
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

  // ---- 2. removed outside Purgeon ------------------------------------------------------------

  const scanRemoved = async (list) => {
    setModal(null);
    const items = [];
    for (const [i, p] of list.entries()) {
      setBusy({ message: `Scanning for leftovers of ${p.name}`, current: i + 1, total: list.length });
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
    if (!id) return setNotice({ tone: 'warn', text: `winget has no package for ${p.name}, so it can't be repaired that way. Use Force instead.` });
    if (!(await api.invoke('dialog:confirm', { confirmId: 'repairUninstaller', message: `Repair ${p.name}'s uninstaller?`, detail: `winget reinstalls the package "${id}" over the existing copy, which puts a working uninstaller back. Then the normal uninstall runs. Reinstalling accepts the package's license terms.` }))) return;
    setBusy(`Reinstalling ${id}…`);
    const r = await api.invoke('winget:repair', id).catch((e) => ({ ok: false, detail: e.message }));
    setBusy('');
    if (!r.ok) return setError(`winget could not reinstall ${id}: ${r.detail}. Use Force instead.`);
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
    if (!(await api.invoke('dialog:confirm', { confirmId: 'getNewerSettings', message: `Get newer settings for ${newer.length} program${newer.length === 1 ? '' : 's'}?`, detail: `${newer.map((p) => `• ${p.name}`).join('\n')}\n\nTheir current settings go to the Recycle Bin first, and each change can be undone from Change History. Close these programs first.` }))) return;
    const results = await restorePackages(newer, true);
    for (const p of newer) lastPull[p.name] = p.mtime;
    await api.invoke('settings:set', { lastPull });
    setModal({ type: 'results', title: 'Settings Received', results });
  };

  // ---- 15. portable apps --------------------------------------------------------------------------------

  const openPortable = async () => {
    setBusy('Looking for portable apps…');
    try {
      const { apps, folders } = await api.invoke('portable:find');
      setModal({ type: 'portable', apps, folders, updates: null });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  };

  const openPortableApps = async () => {
    setBusy('Reading monitored programs…');
    try {
      const programs = await api.invoke('portableapps:list');
      setModal({ type: 'portableapps', programs });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  };

  const openMakePortable = async (program) => {
    // Bug notice: shown before any portable packaging.
    const bugOk = await api.invoke('dialog:confirm', { confirmId: 'bugReport',
      message: 'Portable compiler notice',
      detail: 'The PortableApps.com compiler is new and may have bugs or make mistakes. The developer is actively polishing it to mitigate issues. Always test the resulting portable package before relying on it. Continue?',
      checkboxLabel: "Don't show this notice again",
    });
    if (!bugOk.ok) return;
    if (bugOk.checked) {
      // Remember dismissal (stored in settings)
      try {
        await api.invoke('settings:set', { portableBugNoticeDismissed: true });
      } catch {}
    }

    setBusy('Analyzing program for portable packaging…');
    let items = null;
    let recName = program.name;
    let recPublisher = program.publisher || '';
    let recVersion = program.version || '';

    try {
      // If this is a monitored program, it already has recorded items.
      // Otherwise, scan the installed program to get its files/folders/registry.
      if (program.items && program.items.length > 0) {
        items = program.items;
      } else {
        const scanned = await api.invoke('program:scan', program);
        items = scanned;
      }
    } catch (e) {
      setError(`Failed to analyze program: ${e.message}`);
      setBusy('');
      return;
    } finally {
      setBusy('');
    }

    setModal({
      type: 'makePortable',
      program,
      items,
      name: recName,
      publisher: recPublisher,
      version: recVersion,
    });
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
    analyzeProgram: async (p) => {
      if (view !== 'desktop') return;
      setBusy(`Analyzing ${p.name}: measuring its folders and finding what it hooks into Windows…`);
      try {
        setModal({ type: 'analysis', program: p, data: await api.invoke('program:analyze', p) });
      } catch (e) {
        setError(e.message);
      } finally {
        setBusy('');
      }
    },
    compareNow: (p) => view === 'snapshots' && runCompare(p, null),
    deleteSnapshot: async (p) => {
      if (view !== 'snapshots') return;
      if (!(await api.invoke('dialog:confirm', { confirmId: 'deleteSnapshot', message: `Delete the snapshot "${p.name}"?`, detail: 'The snapshot file is deleted. Your files and settings are not affected.' }))) return;
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
      if (!(await api.invoke('dialog:confirm', { confirmId: 'undoChange', message: `Undo this change?`, detail: p.title }))) return;
      await runUndo(p.id, p.title);
    },
    uninstall: async (p) => {
      if (view === 'history') return actions.undoChange(p);
      if (view === 'archive') return actions.deleteRecord(p);
      if (p.portable) {
        if (!(await confirmWithRestore(`Remove the portable app ${p.name}?`, 'It has no uninstaller: Purgeon removes its folder, its entry and the files and settings it left, after you review them. Everything is backed up first.', 'confirmRemovePortable')).ok) return;
        return scanFor(p, `Remove Portable App – ${p.name}`, (items) => `Purgeon found ${items.length} items belonging to ${p.name}.`);
      }
      if (view === 'snapshots') return actions.deleteSnapshot(p);
      if (view === 'monitored') return uninstallMonitored(p);
      if (view === 'backups') return actions.deleteBackup(p);
      // Signature verification when required by settings.
      if (!p.store && (await api.invoke('settings:get')).requireSignature) {
        const exe = iconPathFor(p);
        if (exe) {
          const sig = await api.invoke('security:verifySignature', { path: exe });
          if (sig.status !== 'Valid') {
            const go = await api.invoke('dialog:confirm', {
              confirmId: 'uninstallUnsigned',
              message: `Uninstall ${p.name} without a valid signature?`,
              detail: `The program's main executable (${exe}) is not digitally signed (status: ${sig.status}). Uninstalling an unsigned program carries a higher risk of removing the wrong thing. Proceed anyway?`,
            });
            if (!go) return;
          }
        }
      }
      const prep = p.store ? null : await prepare([p]);
      const info = prep?.[0];
      const go = await confirmWithRestore(
        `Uninstall ${p.name}?`,
        (p.store ? 'The app package will be removed.' : "The program's own uninstaller will run first, then Purgeon scans for leftovers.") + (info ? prepNote(info) : ''),
        'confirmUninstall'
      );
      if (!go.ok) return;
      if (go.checked) await makeRestorePoint(`Purgeon: before uninstalling ${p.name}`, 'uninstall');
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
          ? `${result.error} Purgeon found ${items.length} items.`
          : result.ok
            ? `Uninstall finished. Purgeon found ${items.length} leftover items.`
            : `The uninstaller exited with code ${result.code}. It may have been cancelled. Purgeon found ${items.length} items.`
      );
    },
    force: async (p) => {
      if (view !== 'desktop') return actions.uninstall(p);
      const [info] = await prepare([p]);
      // Signature verification when required by settings.
      if ((await api.invoke('settings:get')).requireSignature) {
        const exe = iconPathFor(p);
        if (exe) {
          const sig = await api.invoke('security:verifySignature', { path: exe });
          if (sig.status !== 'Valid') {
            const go = await api.invoke('dialog:confirm', {
              confirmId: 'forceUnsigned',
              message: `Force removal of ${p.name} without a valid signature?`,
              detail: `The program's main executable (${exe}) is not digitally signed (status: ${sig.status}). Force removal skips the uninstaller entirely. Proceed anyway?`,
            });
            if (!go) return;
          }
        }
      }
      const go = await confirmWithRestore(
        `Force removal of ${p.name}?`,
        "This skips the program's uninstaller and deletes its files and registry entries directly. Use it for programs whose uninstaller is broken or missing. Everything is backed up first." + prepNote(info, false),
        'confirmForce'
      );
      if (!go.ok) return;
      if (go.checked) await makeRestorePoint(`Purgeon: before force removal of ${p.name}`, 'uninstall');
      scanFor(p, `Force – ${p.name}`, (items) => `Purgeon found ${items.length} items belonging to ${p.name}.`);
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
    programDetail: async (p) => {
      const sizes = view === 'desktop' ? (await api.invoke('programs:sizeHistory').catch(() => ({})))[p.key] : null;
      setModal({ type: 'programDetail', program: p, insight: insight[p.key], sizes });
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
      if (!(await api.invoke('dialog:confirm', { confirmId: 'reinstallArchive', message: `Reinstall ${p.name}?`, detail: `winget installs the package "${id}". Its installer may show its own window. Installing accepts the package's license terms.` }))) return;
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
      if (!(await api.invoke('dialog:confirm', { confirmId: 'putBackLeftovers', message: `Put back what was removed for ${p.name}?`, detail: 'Its leftover files and settings are restored from the removal backup. This does not reinstall the program itself.' }))) return;
      setBusy('Restoring…');
      try {
        const results = (await Promise.all(p.backups.map((b) => api.invoke('backups:restore', b).catch((e) => [{ kind: 'file', path: b, ok: false, detail: e.message }])))).flat();
        setModal({ type: 'results', title: 'Restore Report', results });
      } finally {
        setBusy('');
      }
    },
    deleteRecord: async (p) => {
      if (!(await api.invoke('dialog:confirm', { confirmId: 'deleteFromArchive', message: `Delete ${p.name} from the archive?`, detail: 'Only this record is deleted. Backups stay in Tools › Backups.' }))) return;
      await api.invoke('archive:remove', p.id);
      load();
    },
    restore: async (p) => {
      if (!(await api.invoke('dialog:confirm', { confirmId: 'restoreBackup', message: `Restore the backup of ${p.name}?`, detail: 'Registry keys and values are re-imported. Files must be restored from the Recycle Bin.' }))) return;
      setBusy('Restoring…');
      const results = await api.invoke('backups:restore', p.id).finally(() => setBusy(''));
      setModal({ type: 'results', title: 'Restore Report', results });
    },
    deleteBackup: async (p) => {
      if (await api.invoke('dialog:confirm', { confirmId: 'deleteBackup', message: `Delete the backup of ${p.name}?`, detail: 'This cannot be undone.' })) {
        await api.invoke('backups:remove', p.id);
        load();
      }
    },
  };

  // Applies settings that live outside the page: tray, always on top, detection, hidden programs.
  function applyWindow(s) {
    // Before this choice existed, View › Keep Running in the Tray stored tray: true.
    const close = ['ask', 'tray', 'exit'].includes(s.closeAction) ? s.closeAction : s.tray ? 'tray' : 'ask';
    setCloseAction(close);
    const w = { alwaysOnTop: !!s.alwaysOnTop, minimizeToTray: !!s.minimizeToTray, startInTray: !!s.startInTray };
    setWin(w);
    setDetectOn(s.detectInstallers !== false);
    setHidden(s.hiddenPrograms || {});
    api.invoke('app:setTray', { close, minimize: w.minimizeToTray, visible: w.startInTray }).catch(() => {});
    api.invoke('app:setOnTop', w.alwaysOnTop).catch(() => {});
  }
  const CLOSE_TEXT = {
    ask: 'The close button now asks whether to exit or keep Purgeon running in the tray.',
    tray: 'The close button now keeps Purgeon running in the notification area (tray), where it keeps watching for installers and new startup entries. Left-click the tray icon to open it; exit from its right-click menu.',
    exit: 'The close button now exits Purgeon.',
  };
  const setCloseChoice = (choice) => setOption({ closeAction: choice, tray: choice === 'tray' }, CLOSE_TEXT[choice]);
  // The close button was pressed and the question is due (see the close-requested event).
  const answerClose = async (choice, remember) => {
    setCloseAsk(false);
    if (remember && choice) applyWindow(await api.invoke('settings:set', { closeAction: choice, tray: choice === 'tray' }));
    await api.invoke('app:closeAnswered').catch(() => {});
    if (choice === 'tray') api.invoke('app:hideToTray');
    else if (choice === 'exit') api.invoke('app:quit');
  };

  const setOption = async (patch, text) => {
    applyWindow(await api.invoke('settings:set', patch));
    setNotice({ tone: 'ok', text });
  };
  const setHiddenFor = async (list, hide) => {
    if (!list.length) return;
    const next = { ...hidden };
    for (const r of list) hide ? (next[r.key] = r.name) : delete next[r.key];
    applyWindow(await api.invoke('settings:set', { hiddenPrograms: next }));
    const who = list.length === 1 ? list[0].name : `${list.length} programs`;
    setNotice({
      tone: 'ok',
      text: hide
        ? `${who} ${list.length === 1 ? 'is' : 'are'} hidden from the list. ${list.length === 1 ? 'It is' : 'They are'} still installed, and Windows still lists ${list.length === 1 ? 'it' : 'them'}. View › Show Hidden Programs shows hidden programs so you can unhide them.`
        : `${who} ${list.length === 1 ? 'is' : 'are'} shown in the list again.`,
    });
  };

  const global = {
    toggleOnTop: () => setOption({ alwaysOnTop: !win.alwaysOnTop }, !win.alwaysOnTop ? 'The window now stays in front of other windows (View › Always on Top).' : 'The window no longer stays in front of other windows.'),
    toggleMinTray: () =>
      setOption(
        { minimizeToTray: !win.minimizeToTray },
        !win.minimizeToTray ? 'Minimizing now hides the window in the notification area (tray). Left-click the tray icon to bring it back; right-click it for its menu.' : 'Minimizing keeps the window on the taskbar again.'
      ),
    toggleStartTray: () =>
      setOption(
        { startInTray: !win.startInTray },
        !win.startInTray ? 'Purgeon will start hidden in the notification area (tray). Left-click the tray icon to open the window.' : 'Purgeon will open its window when it starts.'
      ),
    toggleDetect: () =>
      setOption(
        { detectInstallers: !detectOn },
        !detectOn ? 'Purgeon now watches for installers starting, and asks whether to record them.' : 'Installer detection is off. Tools › Monitor an Installation still records installations.'
      ),
    toggleAutostart: async () => {
      try {
        const on = await api.invoke('autostart:set', !autostartOn);
        setAutostartOn(on);
        setNotice({
          tone: 'ok',
          text: on
            ? `Purgeon now starts when you sign in to Windows (a task in Task Scheduler › Purgeon).${win.startInTray ? ' It starts hidden in the tray.' : ' Turn on View › Start Minimized to Tray to start it hidden in the tray.'}`
            : 'Purgeon no longer starts with Windows; its sign-in task was deleted.',
        });
      } catch (e) {
        setError(admin === false ? 'Start with Windows needs administrator rights, to create its sign-in task. Use File › Restart as Administrator.' : e.message);
      }
    },
    toggleHidden: () => setShowHidden((v) => !v),
    takeSnapshot: () => setModal({ type: 'takeSnapshot' }),
    restoreProgram: () => restoreProgramBackup(),
    queue: () => openQueue(),
    queueAdd: () => (view === 'desktop' || view === 'store') && (markedRows.length || current) && queueAdd(markedRows.length ? markedRows : [current]),
    trials: () => openTrials(),
    diskMap: () => openDiskMap(),
    regSearch: () => setModal({ type: 'regSearch' }),
    browsers: () => openBrowsers(),
    portable: () => openPortable(),
    portableapps: async () => openPortableApps(),
    makePortable: async (p) => openMakePortable(p),
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

    toggleShell: async () => {
      try {
        setShellOn(await api.invoke(shellOn ? 'shell:disable' : 'shell:enable'));
        setNotice({ tone: 'ok', text: shellOn ? 'Purgeon was removed from Explorer’s right-click menu.' : 'Explorer’s right-click menu now has "Who owns this?" on files and folders, and "Uninstall with Purgeon" on shortcuts and programs (under Show more options on Windows 11).' });
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
    sysinfo: async () => {
      setModal({ type: 'sysinfo', data: null });
      const data = await api.invoke('app:sysinfo').catch(() => null);
      setModal((m) => (m?.type === 'sysinfo' ? { type: 'sysinfo', data: data || { sections: [] } } : m));
    },
    updates: () => setModal({ type: 'updates' }),
    zoomIn: () => changeZoom(1),
    zoomOut: () => changeZoom(-1),
    zoomReset: () => changeZoom(0),
    toggleGrid: async () => {
      const s = await api.invoke('settings:set', { gridLines: !gridOn });
      setGridOn(s.gridLines !== false);
      setTheme(s.theme || 'dark');
      applyWindow(s);
    },
    toggleSafe: async () => {
      const s = await api.invoke('settings:set', { safeMode: !safeOn });
      setSafeOn(s.safeMode);
      setNotice({ tone: 'ok', text: s.safeMode ? 'Safe mode is on: leftover lists offer only items with a 90%+ match, and never services, scheduled tasks or firewall rules.' : 'Safe mode is off: every finding can be selected.' });
    },
    backupSettings: async () => setModal({ type: 'backupSettings', settings: await api.invoke('settings:get') }),
    confirmationPrompts: async () => setModal({ type: 'confirmationPrompts', settings: await api.invoke('settings:get') }),
    openLog: () => api.invoke('log:open'),
    trustedPublishers: async () => {
      const list = await api.invoke('trusted:list');
      setModal({ type: 'trustedPublishers', publishers: list });
    },
    updateCheck: async () => {
      const s = await api.invoke('update:settings');
      setModal({ type: 'updateCheck', enabled: s.enabled, lastCheck: s.lastCheck });
    },
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
      applyWindow(s);
      api.invoke('backups:prune').catch(() => {});
      setNotice({ tone: 'ok', text: s.createRestorePoints ? 'Restore points are on: confirmations offer to create one first.' : 'Restore points are off: the checkbox starts unticked.' });
    },
    setLanguage: async (code) => {
      await api.invoke('i18n:set', code);
      setLang(code);
      setNotice({ tone: 'ok', text: `Language set to ${code}. Restart Purgeon for all menus to use it.` });
    },
    toggleSync: async () => {
      const next = !syncOn;
      await api.invoke('sync:apply', { folder: syncFolder || undefined, on: next });
      setSyncOn(next);
      setNotice({ tone: 'ok', text: next ? 'Settings sync is on.' : 'Settings sync is off.' });
    },
    pickSyncFolder: async () => {
      const { open: openDialog } = await import('@tauri-apps/plugin-dialog');
      const folder = await openDialog({ title: 'Choose the sync folder', directory: true, multiple: false });
      if (typeof folder === 'string') {
        setSyncFolder(folder);
        await api.invoke('settings:set', { syncFolder: folder });
        await api.invoke('sync:apply', { folder, on: syncOn });
        setNotice({ tone: 'ok', text: 'Sync folder chosen.' });
      }
    },
    toggleSchedule: async () => {
      const next = !scheduleOn;
      await api.invoke('schedule:apply', { enabled: next, scanLeftovers: true, checkStartup: true });
      setScheduleOn(next);
      setNotice({ tone: 'ok', text: next ? 'Background monitoring is on: Purgeon scans for leftovers while the PC is idle.' : 'Background monitoring is off.' });
    },
    schedule: async () => { await dispatch('toggleSchedule'); },
    syncFolder: async () => { await pickSyncFolder(); },
    language: async () => {
      const next = lang === 'en' ? 'es' : lang === 'es' ? 'de' : lang === 'de' ? 'fr' : 'en';
      await api.invoke('i18n:set', next);
      setLang(next);
      setNotice({ tone: 'ok', text: `Language switched to ${next}.` });
    },
  };

  const dispatch = (action) => {
    setMenu(null);
    if (action.startsWith('view:')) return setView(action.slice(5));
    if (action.startsWith('close:')) return setCloseChoice(action.slice(6));
    if (action === 'welcome') return setWelcomeOpen(true);
    if (action === 'shortcuts') return setModal({ type: 'shortcuts' });
    if (action === 'guide') return setModal({ type: 'guide' });
    if (action.startsWith('theme:')) {
      const th = action.slice(6);
      setTheme(th);
      return api.invoke('settings:set', { theme: th });
    }
    if (action.startsWith('filter:')) return setQuickFilter(action.slice(7));
    if (action === 'navBack') return goBack();
    if (action === 'navForward') return goForward();
    if (action.startsWith('recent:')) {
      const p = recentPrograms.find((r) => r.key === action.slice(7));
      if (p) {
        setView('desktop');
        setSelected(p.key);
      }
      return;
    }
    if (global[action]) return global[action]();
    if (busy || modal) return;
    if (action === 'clearSelection') return setMarked(new Set(current ? [current.key] : []));
    if (action === 'uninstall' && isBatch) return batchUninstall(markedRows);
    if (action === 'setGroup') return batchable && openGroupDialog(markedRows.length ? markedRows : [current].filter(Boolean));
    if (action === 'hide' || action === 'unhide') return batchable && setHiddenFor(markedRows.length ? markedRows : [current].filter(Boolean), action === 'hide');
    if (current && actions[action]) actions[action](current);
  };
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;

  // Undo stack: records the last removable action so it can be undone within 30 seconds.
  const addUndo = useCallback(async (label, undoFn) => {
    setUndoStack((prev) => [...prev.slice(-4), { label, undoFn, time: Date.now() }]);
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    const t = setTimeout(() => setUndoStack([]), 30000);
    undoTimerRef.current = t;
  }, []);

  const clearUndo = useCallback(() => {
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    setUndoStack([]);
    undoTimerRef.current = null;
  }, []);

  useEffect(() => installTips(), []);

  // Installers starting: checked every 3 seconds while Purgeon runs, in the tray too. Not
  // while Purgeon itself is busy (program updates run installers) or already monitoring,
  // or during the first half hour of a trial install (that installation is the trial's).
  const busyRef = useRef('');
  busyRef.current = busy;
  useEffect(() => {
    if (!detectOn) return undefined;
    let stopped = false;
    api.invoke('installers:check').catch(() => {});
    const timer = setInterval(async () => {
      const found = await api.invoke('installers:check').catch(() => []);
      if (stopped || !found.length || busyRef.current) return;
      if (await api.invoke('monitor:status').catch(() => null)) return;
      const trials = await api.invoke('trials:list').catch(() => []);
      if (trials.some((t) => Date.now() - new Date(t.started).getTime() < 30 * 60 * 1000)) return;
      const inst = found[0];
      notify('Installer started', `${inst.name} is being installed. Purgeon can record what it installs.`);
      api.invoke('app:show').catch(() => {});
      setModal((m) => m || { type: 'installerFound', installer: inst });
    }, 3000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [detectOn]); // eslint-disable-line react-hooks/exhaustive-deps

  const monitorDetected = async (inst) => {
    setModal(null);
    setBusy(`Taking a snapshot before ${inst.name} installs… Leave its installer on the first page until this is done.`);
    try {
      await api.invoke('monitor:attach', { installer: inst.path, name: inst.name });
      setModal({ type: 'monitor', resume: await api.invoke('monitor:status') });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  };
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
      else if (e.ctrlKey && key === 'i') action = 'analyzeProgram';
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
      else if (e.altKey && key === 'ArrowLeft') { e.preventDefault(); goBack(); }
      else if (e.altKey && key === 'ArrowRight') { e.preventDefault(); goForward(); }
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
  // They are applied to the list in batches (at most one pass every 250 ms), so a
  // long measuring run does not re-render the list once per program.
  useEffect(() => {
    const flushMeasured = () => {
      measuredTimer.current = null;
      if (!measuredPending.current.size) return;
      const byKey = measuredPending.current;
      measuredPending.current = new Map();
      const merge = (p) => (byKey.has(p.key) ? { ...p, ...byKey.get(p.key) } : p);
      desktopCache.current = desktopCache.current.map(merge);
      setRows((rs) => rs.map((r) => (byKey.has(r.key) ? toRow('desktop', merge(r)) : r)));
    };
    const off = api.onMeasured((m) => {
      // Sizes measured this session go into the size history once the measuring settles.
      clearTimeout(sizeTimer.current);
      sizeTimer.current = setTimeout(() => api.invoke('programs:recordSizes', desktopCache.current).catch(() => {}), 15000);
      const prev = measuredPending.current.get(m.key);
      measuredPending.current.set(m.key, prev ? { ...prev, ...m } : m);
      if (!measuredTimer.current) measuredTimer.current = setTimeout(flushMeasured, 250);
    });
    return () => {
      off();
      if (measuredTimer.current) clearTimeout(measuredTimer.current);
      measuredTimer.current = null;
    };
  }, []);

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
    ? [['uninstall', `Uninstall ${markedRows.length} Programs...`, 'Del'], ['queueAdd', `Add ${markedRows.length} Programs to the Queue`, 'Ctrl+Q'], ['setGroup', `Set Group for ${markedRows.length} Programs...`, 'Ctrl+G'], ['hide', `Hide ${markedRows.length} Programs From List`], ['unhide', `Unhide ${markedRows.length} Programs`], null, ['clearSelection', 'Clear Selection']]
    : view === 'history'
      ? [['undoChange', 'Undo This Change', 'Del']]
    : view === 'archive'
      ? [['reinstall', 'Reinstall with winget...'], ['openSite', 'Publisher Website'], ['restoreRemoval', 'Put Back Removed Leftovers...'], null, ['deleteRecord', 'Delete From Archive', 'Del']]
    : view === 'snapshots'
      ? [['compareNow', 'Compare with Now'], ['compareSelected', 'Compare the Two Selected'], null, ['deleteSnapshot', 'Delete Snapshot', 'Del']]
    : view === 'backups'
      ? [['restore', 'Restore'], ['properties', 'Show Contents'], null, ['deleteBackup', 'Delete Backup']]
      : view === 'monitored'
        ? [['uninstall', 'Uninstall...'], ['makePortable', 'Make Portable...'], null, ['properties', 'Recorded Changes'], ['search', 'Search Online']]
        : view === 'store'
          ? [['uninstall', 'Uninstall...'], ['setGroup', 'Set Group...', 'Ctrl+G'], ['makePortable', 'Make Portable...'], null, ['folder', 'Installation Folder'], ['search', 'Search Online'], null, ['properties', 'Properties']]
          : [
              ['uninstall', 'Uninstall...', 'Del'],
              ['force', 'Force...', 'Shift+Del'],
              ['analyze', 'Analyze Leftovers...', 'Ctrl+L'],
              ['removeEntry', 'Remove Entry...'],
              ['setGroup', 'Set Group...', 'Ctrl+G'],
              ['backupProgram', 'Migrate / Back Up Program...'],
              ['queueAdd', 'Add to Uninstall Queue', 'Ctrl+Q'],
              current && hidden[current.key] ? ['unhide', 'Unhide'] : ['hide', 'Hide From List'],
              ['analyzeProgram', 'Analyze Program...', 'Ctrl+I'],
              ['sheet', 'What’s This...', 'Ctrl+W'],
              ['rescue', 'Rescue Broken Uninstall...'],
              ['makePortable', 'Make Portable...'],
              null,
              ['registry', 'Registry Entry'],
              ['folder', 'Installation Folder'],
              ['search', 'Search Online'],
              null,
              ['properties', 'Properties', 'Alt+Enter'],
              ['programDetail', 'Show Details...'],
            ];

  const totalKB = view === 'desktop' ? visible.reduce((s, r) => s + (r.sizeKB || 0), 0) : 0;
  const cols = VIEWS[view].cols;
  // A row's tooltip: what it is, and what clicking it does.
  const rowTip = (r) => {
    if (view === 'desktop' || view === 'store') {
      const lines = [
        `${r.name}${r.version ? ` ${r.version}` : ''}`,
        r.publisher && `Publisher: ${r.publisher}`,
        r.date && `Installed on: ${r.date}`,
        r.location && `Folder: ${r.location}`,
        hidden[r.key] && 'Hidden from the list (Action › Unhide shows it normally again)',
        '',
        'Double-click: uninstall. Right-click: everything you can do with it. Ctrl+click or Shift+click: select several.',
      ];
      return lines.filter((l) => l !== false && l !== undefined && l !== null).join('\n');
    }
    if (view === 'monitored') return `${r.name}: an installation Purgeon recorded.\nDouble-click: uninstall it, removing exactly what its installation created.`;
    if (view === 'snapshots') return `${r.name}\nClick to select; Ctrl+click a second snapshot to compare the two. Double-click: compare with the system now.`;
    if (view === 'backups') return `${r.name}\nDouble-click: restore what this backup holds.`;
    if (view === 'history') return `${r.name}\nDouble-click: undo this change, from the backup taken when it was made.`;
    if (view === 'archive') return `${r.name}\nDouble-click: reinstall it with winget. Right-click: website, or put back removed leftovers.`;
    return r.name;
  };
  const cellFor = (r, c) => (c === 'size' ? r.sizeText : c === 'date' ? r.date : c === 'arch' ? archOf(r).text : r[c]);

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
      ? [...DESKTOP_BAR.map((id) => contextItems.find((i) => i && i[0] === id)).filter(Boolean), ['sysinfo', 'System Info']]
      : view === 'snapshots'
        ? [['takeSnapshot', 'Take Snapshot'], ...contextItems.filter(Boolean)]
        : view === 'timeline' || VIEW_NOTES[view]
          ? []
          : view === 'store'
            ? [...contextItems.filter(Boolean), ['sysinfo', 'System Info']]
            : contextItems.filter(Boolean);
  // Row 2: what is selected, or what to do in this view.
  const HINTS = {
    desktop: 'Nothing selected: click a program to see what you can do with it (double-click uninstalls it).',
    store: 'Nothing selected: click an app to see what you can do with it.',
    monitored: 'Click a recorded installation; double-click uninstalls exactly what it installed.',
    snapshots: 'Click a snapshot, then Ctrl+click a second to compare the two, or double-click one to compare it with now.',
    backups: 'Double-click a backup to restore what it removed.',
    history: 'Double-click a change to undo it.',
    archive: 'Programs removed so far. Double-click one to reinstall it with winget.',
    timeline: 'Everything that changed on this PC that Purgeon knows of, newest first.',
  };
  const details = (() => {
    if (VIEW_NOTES[view]) return { main: VIEW_NOTES[view], more: '' };
    if (isBatch) return { main: `${markedRows.length} programs selected`, more: `${formatSize(markedRows.reduce((n, r) => n + (r.sizeKB || 0), 0)) || 'size unknown'} together · the actions below apply to all of them` };
    if (!current) return { main: HINTS[view] || '', more: '', none: true };
    if (!batchable) return { main: current.name, more: HINTS[view] || '' };
    return {
      main: `${current.name}${current.version && !current.name.includes(current.version) ? ` ${current.version}` : ''}`,
      more: [current.publisher, current.sizeText, view === 'desktop' && archOf(current).text, current.date && `installed ${current.date}`, groups[current.key] && `group ${groups[current.key]}`, hidden[current.key] && 'hidden'].filter(Boolean).join(' · '),
    };
  })();
  const barReady = (id) => (id === 'sysinfo' || id === 'takeSnapshot' ? true : id === 'compareSelected' ? markedRows.length === 2 : isBatch || !!current);

  // The main window keeps the layout of the README screenshot — menu bar, command bar,
  // selection bar, action bar, list, status bar, and nothing else — so the quick list
  // filters, Back/Forward and the recent programs live in the View menu instead of in
  // extra bars and rails on the window. Safe Mode likewise lives in the Tools menu.
  const filterItems = [
    ['filter:all', 'Show All Programs'],
    ['filter:desktop', 'Show Desktop Programs Only'],
    ['filter:store', 'Show Store Apps Only'],
    ['filter:recent', 'Show Recently Installed'],
    ['filter:large', 'Show Large Programs (over 100 MB)'],
    ['filter:unsigned', 'Show Unsigned Programs'],
    ['filter:used', 'Show Recently Used Programs'],
  ];
  // Balanced action-bar rows: as many columns as fit at a width where the longest
  // label ("Search Online") still fits whole, then the column count is rounded so
  // every row holds the same number of buttons (13 actions lay out 7 + 6 at a wide
  // window, 5 + 5 + 3 at a narrow one — never 10 + 3), for any view's actions.
  const barCount = barItems.length;
  const barFit = actionBarW > 0 ? Math.max(1, Math.floor((actionBarW + 6) / 134)) : barCount;
  const barCols = barCount === 0 || barFit >= barCount ? barCount : Math.ceil(barCount / Math.ceil(barCount / barFit));
  const menus = MENUS.map(([label, entries]) => {
    if (label !== 'View') return [label, entries];
    const out = [];
    for (const it of entries) {
      out.push(it);
      if (it && it[0] === 'refresh') out.push(null, ['navBack', 'Back', 'Alt+Left'], ['navForward', 'Forward', 'Alt+Right'], null, ...filterItems);
    }
    if (recentPrograms.length) out.push(null, ...recentPrograms.map((p) => [`recent:${p.key}`, `Recent: ${p.name.length > 42 ? `${p.name.slice(0, 42)}…` : p.name}`]));
    return [label, out];
  });

  return (
    <div className={`app ${gridOn ? 'grid' : ''}`} onClick={() => menu && setMenu(null)}>
      <a href="#main-content" className="skip-to-content">Skip to main content</a>
      <MenuBar menus={menus} onAction={dispatch} controls={<WindowControls pinned={win.alwaysOnTop} toTray={win.minimizeToTray} onPin={() => dispatch('toggleOnTop')} />} right={
          admin === false ? (
            <button className="link elevate" onClick={() => api.invoke('app:elevate')} title="Needed to remove programs installed for all users, and for machine-wide changes">
              Not Elevated – Restart as Administrator
            </button>
          ) : admin ? (
            <span className="elevated">Administrator</span>
          ) : null
        }
        checked={{ toggleRestore: restoreOn, toggleSilent: silentOn, toggleSafe: safeOn, toggleGrid: gridOn, 'theme:dark': theme === 'dark', 'theme:light': theme === 'light', 'theme:contrast': theme === 'contrast', 'filter:all': quickFilter === 'all', 'filter:desktop': quickFilter === 'desktop', 'filter:store': quickFilter === 'store', 'filter:recent': quickFilter === 'recent', 'filter:large': quickFilter === 'large', 'filter:unsigned': quickFilter === 'unsigned', 'filter:used': quickFilter === 'used', 'close:ask': closeAction === 'ask', 'close:tray': closeAction === 'tray', 'close:exit': closeAction === 'exit', toggleShell: shellOn, toggleOnTop: win.alwaysOnTop, toggleMinTray: win.minimizeToTray, toggleStartTray: win.startInTray, toggleAutostart: autostartOn, toggleDetect: detectOn, toggleHidden: showHidden, toggleSync: syncOn, toggleSchedule: scheduleOn }} />
      {/* Premium header band: the open view's name, a one-line summary, and its headline number. */}
      <div className="view-band">
        <div className="band-logo"><ViewIcon id={view} /></div>
        <div>
          <div className="band-title">{view === 'desktop' ? 'Purgeon' : VIEWS[view].label}</div>
          <div className="band-sub">
            {view === 'desktop' || view === 'store' ? (
              <span className="band-pill"><span className="band-dot" />{loading ? 'Loading…' : `${rows.length} ${VIEWS[view].noun} installed`}</span>
            ) : view === 'debloat' ? (
              'Safe, reversible Windows tweaks. Every tweak can be undone here.'
            ) : view === 'junk' ? (
              'Only safe categories — caches, dumps and temporary files Windows rebuilds.'
            ) : (
              `${visible.length} ${VIEWS[view].noun}`
            )}
          </div>
        </div>
        {(view === 'desktop' || view === 'store') && totalKB > 0 && (
          <div className="band-stat"><b>{formatSize(totalKB)}</b><span>total size of installed {VIEWS[view].noun}</span></div>
        )}
      </div>
      <div className="workspace">
      {/* The views, as icons; each one's name and shortcut is in its tooltip. */}
      <nav className="view-bar-side" aria-label="Views">
        {VIEW_CHIPS.map(([id, label, title]) => (
          <button key={id} className={`view-chip ${view === id ? 'on' : ''}`} onClick={() => (VIEWS[id].button ? toggleView(id) : setView(id))} aria-pressed={view === id} title={`${label}: ${title}`}>
            <ViewIcon id={id} />
            <span className="sr-only">{label}</span>
          </button>
        ))}
      </nav>
      <main className="workspace-main" id="main-content">
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
            title="Type to filter the list by name, publisher or group. Matching menu commands appear below: press Down, then Enter to run one. Esc clears."
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
      {/* Row 2: what is selected (or what this view is for), and the group filter. */}
      <div className="toolbar details-bar" role="status" aria-label="Selection">
        <span className={`details-main ${details.none ? 'none' : ''}`} title={details.more ? `${details.main} · ${details.more}` : details.main}>
          {details.main}
        </span>
        {details.more && <span className="details-more">{details.more}</span>}
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
      {/* Row 3: the actions for the selection, in balanced rows of equal-width buttons. */}
      {barItems.length > 0 && (
        <div className="action-bar" role="toolbar" aria-label="Actions" ref={actionBarRef} style={barCols > 0 ? { gridTemplateColumns: `repeat(${barCols}, minmax(0, 1fr))` } : undefined}>
          {barItems.map(([id, label]) => (
            <button key={id} className={`action-button ${id === 'uninstall' ? 'primary' : ''} ${/^(force|delete)/i.test(id) ? 'danger' : ''}`} disabled={!barReady(id)} onClick={() => dispatch(id)} title={ACTION_TIPS[id]} aria-label={shortLabel(label)}>
              {shortLabel(label)}
            </button>
          ))}
        </div>
      )}
      {view === 'snapshots' && !loading && (
        <SnapshotTimeline snapshots={rows.filter((r) => r.stats && r.created)} marked={marked} onSelect={(key, ctrl) => selectRow(key, { ctrl })} onCompare={(a, b) => runCompare(a, b)} onCompareNow={(s) => runCompare(s, null)} />
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
            if (!(await api.invoke('dialog:confirm', { confirmId: 'removeFirewallRules', message: `Remove ${r.names.length === 1 ? 'the firewall rule' : `${r.names.length} firewall rules`} for "${r.display}"?`, detail: `${r.program} will no longer accept incoming connections through ${r.names.length === 1 ? 'this rule' : 'these rules'}. Each rule is backed up first and can be restored from Change History.` }))) return;
            removeWithBackup(`Firewall rules for ${r.display}`, r.names.map((n) => ({ kind: 'firewall', path: n, name: r.display, confidence: 'high', reason: 'Inbound rule' })));
          }}
        />
      ) : view === 'junk' ? (
        <JunkView key={customKey} filter={filter} admin={admin} onError={setError} onStatus={setCustomStatus} onClean={cleanJunk} />
      ) : (
      <div className={`list view-${view}`} tabIndex={0} ref={listRef} onKeyDown={onListKey}>
        <div className="list-header">
          {cols.map(([id, label]) => (
            <div key={id} className={`col col-${id}`} onClick={() => setSort((s) => ({ col: id, dir: s.col === id ? -s.dir : 1 }))} title={`Sort by ${label.toLowerCase()}. Click again to reverse the order.`}>
              {label}
              {sort.col === id && <span className="sort">{sort.dir > 0 ? '▲' : '▼'}</span>}
            </div>
          ))}
        </div>
        {loading ? (
          <div className="list-empty">Loading…</div>
        ) : visible.length === 0 ? (
          <div className="list-empty list-empty-actionable">
            <span>{emptyStateMessage(view, filter)}</span>
            {emptyStateActions(view, () => setModal({ type: 'monitor' }), () => setModal({ type: 'snapshot' }), () => load()).map((a, i) => (
              <button key={i} className="list-empty-action" onClick={a.onClick} title={a.title}>
                {a.label}
              </button>
            ))}
          </div>
        ) : (
          visible.map((r, idx) => (
            <div
              key={r.key}
              data-idx={idx}
              className={`row ${marked.has(r.key) ? 'selected' : ''} ${r.key === selected ? 'focused' : ''} ${r.arch === 'user' ? 'user' : ''} ${batchable && hidden[r.key] ? 'hidden-row' : ''}`}
              title={rowTip(r)}
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
                          : id === 'arch'
                            ? archOf(r).how
                            : undefined
                    }
                  >
                    {cellFor(r, id)}
                    {id === 'size' && r.sizeTruncated ? '+' : ''}
                  </span>
                  {id === 'name' && ((batchable && (hidden[r.key] || groups[r.key])) || (view === 'desktop' && insight[r.key])) && (
                    <span className="cell-tags">
                      {batchable && hidden[r.key] && (
                        <span className="hidden-tag" title="Hidden from the list (Action › Hide From List). It is still installed; Action › Unhide shows it normally again.">
                          hidden
                        </span>
                      )}
                      {batchable && groups[r.key] && (
                        <span className="group-tag" title={`In the group "${groups[r.key]}". Pick it in the group list to show only this group; Set Group (Ctrl+G) changes it.`}>
                          {groups[r.key]}
                        </span>
                      )}
                      {view === 'desktop' && <InsightTags i={insight[r.key]} />}
                    </span>
                  )}
                </div>
              ))}
            </div>
          ))
        )}
      </div>
      )}

      {/* Messages sit at the bottom, just above the status bar. */}
      {error && (
        <div className="error-bar" aria-live="polite" aria-label="Error">
          <span>{error.msg || error}</span>
          {error.retry && (
            <button onClick={error.retry} title="Try again">↻ Retry</button>
          )}
          <button onClick={() => setError('')}>✕</button>
        </div>
      )}
      {notice && (
        <div className={`notice-bar ${notice.tone}`} aria-live="polite" aria-label="Notice">
          <span>{notice.text}</span>
          <button onClick={() => setNotice(null)} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}
      {undoStack.length > 0 && (
        <div className="undo-toast" aria-live="polite" aria-label="Undo available">
          <span>Undo: {undoStack[undoStack.length - 1].label}</span>
          <button className="primary" onClick={() => {
            const u = undoStack[undoStack.length - 1];
            u.undoFn().then(() => clearUndo()).catch(() => setError('Undo failed.'));
          }}>Undo</button>
          <button onClick={clearUndo}>✕</button>
        </div>
      )}
      </main>
      </div>

      <div className="statusbar">
        {VIEWS[view].custom ? (
          <span>{customStatus}</span>
        ) : (
          <span title="How many entries the list shows, and their total size where it is known">
            {loading ? 'Loading' : visible.length} {VIEWS[view].noun}
            {totalKB ? `, total size ${formatSize(totalKB)}` : ''}
            {filter && rows.length !== visible.length ? ` (of ${rows.length})` : ''}
            {isBatch ? `, ${markedRows.length} selected` : ''}
            {hiddenCount > 0 && (
              <button className="link hidden-count" onClick={() => dispatch('toggleHidden')} title={showHidden ? 'Hidden programs are shown dimmed. Click to hide them again.' : 'Programs you hid with Action › Hide From List. Click to show them dimmed, so you can unhide them.'}>
                {`, ${hiddenCount} hidden${showHidden ? ' (shown)' : ''}`}
              </button>
            )}
          </span>
        )}
        <span className="status-right">
          {specs && (specs.osName || specs.cpu || specs.ramBytes > 0) && (
            <span
              className="pc-specs"
              title={[specs.osName && `Operating system: ${specs.osName}${specs.osVersion ? ` ${specs.osVersion}` : ''}${specs.osBuild ? ` (build ${specs.osBuild})` : ''}`, specs.cpu && `Processor: ${specs.cpu}`, specs.ramBytes > 0 && `Memory: ${ramTextOf(specs.ramBytes)}`].filter(Boolean).join('\n')}
            >
              {[specs.osName, shortCpu(specs.cpu), ramTextOf(specs.ramBytes)].filter(Boolean).join(' · ')}
            </span>
          )}
          {current && view === 'desktop' && <span className="muted" title="Publisher of the selected program, as its uninstall entry reports it">{current.publisher}</span>}

        </span>
      </div>

      {menu && current && (
        <div className="context-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()} role="menu">
          {contextItems.map((it, i) =>
            it ? (
              <button key={i} className={i === 0 ? 'bold' : ''} role="menuitem" onClick={() => dispatch(it[0])} title={ACTION_TIPS[it[0]]} aria-label={it[1]}>
                <span>{it[1]}</span>
                <span className="accel">{it[2]}</span>
              </button>
            ) : (
              <div key={i} className="sep" role="separator" />
            )
          )}
        </div>
      )}

      {busy && <Busy busy={busy} onStop={busyStop} onPause={busy?.onPause} onCancel={busy?.onCancel} />}
      {welcomeOpen && (
        <WelcomeDialog
          onClose={() => {
            setWelcomeOpen(false);
            if (hasSeenWelcome === false) setTipsActive(true);
            markWelcomeSeen();
          }}
          onGetStarted={(path) => {
            setWelcomeOpen(false);
            if (hasSeenWelcome === false) setTipsActive(true);
            markWelcomeSeen();
            if (path === 'programs') setView('desktop');
            else if (path === 'monitor') setModal({ type: 'monitor' });
            else if (path === 'junk') setView('junk');
          }}
        />
      )}
      {tipsActive && !welcomeOpen && (
        <FirstRunTips
          visible={true}
          dismissed={firstRunTipDismissed}
          onTipAction={(tipId) => {
            setFirstRunTipDismissed((d) => new Set([...d, tipId]));
            if (tipId === 'find-anything') setPalette(true);
          }}
          onClose={() => {
            setFirstRunTipDismissed((d) => new Set([...d, ...FIRST_RUN_TIPS.map((t) => t.id)]));
          }}
        />
      )}
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
      {modal?.type === 'confirmationPrompts' && (
        <ConfirmationSettingsDialog
          settings={modal.settings}
          onSave={async (patch) => {
            await api.invoke('settings:set', patch);
            setNotice({ tone: 'ok', text: 'Confirmation prompt settings saved.' });
          }}
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
      {modal?.type === 'sysinfo' && <SystemInfoDialog data={modal.data} onClose={() => setModal(null)} />}
      {modal?.type === 'about' && <AboutDialog onClose={() => setModal(null)} />}
      {modal?.type === 'shortcuts' && <ShortcutsDialog onClose={() => setModal(null)} />}
      {modal?.type === 'guide' && <UserGuide onClose={() => setModal(null)} />}
      {modal?.type === 'updateAvailable' && (
        <UpdateAvailableDialog
          version={modal.version}
          onClose={() => setModal(null)}
          onDownload={() => {
            setModal(null);
            api.invoke('program:openUrl', 'https://github.com/SeanShaffer88/Purgeon/releases').catch(() => {});
          }}
        />
      )}
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
            if (!(await api.invoke('dialog:confirm', { confirmId: 'keepTrial', message: `Keep ${t.name}?`, detail: 'The trial ends and its snapshot is deleted. The program stays installed; you can still uninstall it normally later.' }))) return;
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
          folders={modal.folders}
          updates={modal.updates}
          checking={modal.checking}
          onRegister={async (a) => {
            try {
              await api.invoke('portable:register', a);
              setNotice({ tone: 'ok', text: `${a.name} is now in the program list.` });
              load();
              openPortable();
            } catch (e) {
              setError(e.message);
            }
          }}
          onUnregister={async (a) => {
            const p = desktopCache.current.find((x) => x.portable && String(x.location).toLowerCase() === a.folder.toLowerCase());
            if (p) await api.invoke('portable:unregister', p.key.replace(/^HKCU/, 'HKEY_CURRENT_USER')).catch((e) => setError(e.message));
            load();
            openPortable();
          }}
          onAddFolder={async () => {
            const f = await api.invoke('transfer:pickFolder', 'Choose the folder that holds your portable apps');
            if (!f) return;
            await api.invoke('portable:addFolder', f);
            openPortable();
          }}
          onRemoveFolder={async (f) => {
            await api.invoke('portable:removeFolder', f);
            openPortable();
          }}
          onCheckUpdates={async () => {
            const apps = modal.apps;
            setModal((m) => ({ ...m, checking: true }));
            try {
              const updates = await api.invoke('portable:checkUpdates', apps.map((a) => ({ folder: a.folder, name: a.name, version: a.version })));
              setModal((m) => (m?.type === 'portable' ? { ...m, updates, checking: false } : m));
            } catch (e) {
              setModal((m) => (m?.type === 'portable' ? { ...m, checking: false } : m));
              setError(e.message);
            }
          }}
          onOpenUrl={(url) => /^https?:\/\//i.test(url) && api.invoke('open:url', url)}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === 'portableapps' && (
        <PortableAppsDialog
          programs={modal.programs}
          onGenerate={async (args) => {
            try {
              const f = await api.invoke('transfer:pickFolder', 'Choose the folder for the PortableApps.com package');
              if (!f) return;
              setBusy('Generating PortableApps.com package…');
              const result = await api.invoke('portableapps:generate', { ...args, outputDir: f });
              setBusy('');
              setNotice({
                tone: 'ok',
                text: `PortableApps.com package generated for "${result.name}". NSIS script: ${result.nsiScriptPath}`,
              });
              setModal(null);
            } catch (e) {
              setError(e.message);
            } finally {
              setBusy('');
            }
          }}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === 'makePortable' && (
        <MakePortableDialog
          program={modal.program}
          items={modal.items}
          name={modal.name}
          publisher={modal.publisher}
          version={modal.version}
          onGenerate={async (args) => {
            try {
              const f = await api.invoke('transfer:pickFolder', 'Choose the folder for the PortableApps.com package');
              if (!f) return;
              setBusy('Creating PortableApps.com package…');
              const result = await api.invoke('portableapps:generate', {
                ...args,
                outputDir: f,
                items: modal.items,
              });
              setBusy('');
              setNotice({
                tone: 'ok',
                text: `PortableApps.com package generated for "${result.name}". NSIS script: ${result.nsiScriptPath}`,
              });
              setModal(null);
            } catch (e) {
              setError(e.message);
            } finally {
              setBusy('');
            }
          }}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === 'programDetail' && (
        <ProgramDetailDialog
          program={modal.program}
          insight={modal.insight}
          sizes={modal.sizes}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === 'trustedPublishers' && (
        <TrustedPublishersDialog
          publishers={modal.publishers}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === 'updateCheck' && (
        <UpdateCheckDialog
          enabled={modal.enabled}
          lastCheck={modal.lastCheck}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === 'ctxmenu' && (
        <ContextMenuDialog
          entries={modal.entries}
          admin={admin}
          onToggle={async (e) => {
            if (e.admin && admin === false) return setError(`"${e.name}" needs administrator rights. Use File › Restart as Administrator.`);
            if (e.enabled && e.windows && !(await api.invoke('dialog:confirm', { confirmId: 'turnOffCtxMenu', message: `Turn off "${e.name}"?`, detail: 'This entry is part of Windows or a Microsoft product (such as the virus scan entry). Turning it off is reversible.' }))) return;
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
              await api.invoke('export:html', { title: 'Save Monthly Report', fileName: `purgeon-report-${month}.html`, html });
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
      {closeAsk && <CloseDialog onAnswer={answerClose} />}
      {modal?.type === 'analysis' && (
        <AnalysisDialog
          program={modal.program}
          data={modal.data}
          insight={insight[modal.program.key]}
          onSheet={() => openSheet(modal.program)}
          onLeftovers={() => {
            const p = modal.program;
            setModal(null);
            setTimeout(() => actions.analyze(p), 0);
          }}
          onUninstall={() => {
            const p = modal.program;
            setModal(null);
            setTimeout(() => actions.uninstall(p), 0);
          }}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === 'installerFound' && (
        <InstallerFoundDialog
          installer={modal.installer}
          onMonitor={() => monitorDetected(modal.installer)}
          onStop={() => {
            setModal(null);
            dispatch('toggleDetect');
          }}
          onClose={() => setModal(null)}
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
