// English-only presentation catalog. Persisted identifiers remain compatible.
// t() uses stable named keys; tx() preserves English literals and interpolates data.
import { readSettings, writeSettings } from './settings.js';
const EN = { ...{
    language: 'English',
    // App
    appName: 'Purgeon',
    appTagline: 'Windows uninstaller with leftover scanning, install monitoring and backups',
    // Views
    viewPrograms: 'Programs',
    viewApps: 'Apps',
    viewMonitored: 'Monitored',
    viewStartup: 'Startup',
    viewServices: 'Services',
    viewDebloat: 'Debloat',
    viewJunk: 'Cleaner',
    viewSnapshots: 'Snapshots',
    viewTimeline: 'History',
    viewArchive: 'Archives',
    // Actions
    actionUninstall: 'Uninstall',
    actionForce: 'Force',
    actionAnalyze: 'Analyze',
    actionSheet: 'Sheet',
    actionBackup: 'Back Up',
    actionQueue: 'Queue',
    actionGroup: 'Group',
    actionHide: 'Hide',
    actionUnhide: 'Unhide',
    actionFolder: 'Folder',
    actionRegistry: 'Registry',
    actionSearch: 'Search',
    actionProperties: 'Properties',
    // Status
    statusReady: 'Ready',
    statusScanning: 'Scanning…',
    statusRemoving: 'Removing…',
    statusDone: 'Done',
    statusError: 'Error',
    // Settings
    settingsTitle: 'Settings',
    settingsLanguage: 'Language',
    settingsSilentUninstall: 'Silent uninstall when possible',
    settingsSafeMode: 'Safe Mode (strong ownership evidence)',
    settingsCreateRestorePoints: 'Create a restore point before changes',
    settingsBackupMaxDays: 'Keep backups no older than (days, 0 = unlimited)',
    settingsBackupMaxMB: 'Keep backups no larger than (MB, 0 = unlimited)',
    settingsGridLines: 'Show grid lines',
    settingsStartWithWindows: 'Start Purgeon with Windows',
    settingsMonitoring: 'Background monitoring',
    settingsScanLeftovers: 'Scan for leftovers of programs removed elsewhere',
    settingsCheckStartup: 'Alert on new startup entries',
    settingsSyncFolder: 'Sync settings to a folder (OneDrive, Dropbox, Google Drive…)',
    settingsSyncFolderPick: 'Choose sync folder…',
    settingsSyncFolderClear: 'Clear sync folder',
    // Commands
    cmdSnapshot: 'Take a snapshot',
    cmdRestorePoint: 'Create a restore point',
    cmdAssociations: 'File association lookup',
    cmdSchedule: 'Scheduled monitoring',
    cmdPlugins: 'Manage plugins',
    cmdProfiler: 'Startup profiler',
    // Generic
    ok: 'OK',
    cancel: 'Cancel',
    yes: 'Yes',
    no: 'No',
    confirm: 'Confirm',
    backup: 'Backup',
    undo: 'Undo',
    restart: 'Restart',
    restartLater: 'Restart later',
    never: 'Never',
    more: 'More',
    less: 'Less',
    none: 'None',
    all: 'All',
    search: 'Search',
    filter: 'Filter',
    sort: 'Sort',
    size: 'Size',
    date: 'Date',
    name: 'Name',
    publisher: 'Publisher',
    version: 'Version',
    arch: 'Arch',
    installedOn: 'Installed On',
    removedOn: 'Removed On',
    backedUpOn: 'Backed Up On',
    takenOn: 'Taken On',
    entries: 'Entries',
    items: 'Items',
    programs: 'Programs',
    noResults: 'No results.',
    yesNo: (v) => (v ? 'Yes' : 'No'),
    onOff: (v) => (v ? 'On' : 'Off'),
    enabledDisabled: (v) => (v ? 'Enabled' : 'Disabled'),
  }, ...{
    "close": "Close",
    "busyLabel": "Operation in progress",
    "moreActions": "More actions",
    "actionsLabel": "Actions",
    "navLabels": "Toggle navigation labels",
    "viewsLabel": "Views",
    "syncPreferencesTitle": "Review preference sync",
    "syncFolderLabel": "Shared folder",
    "syncSafeFields": "Only theme, text size, reduced motion, and grid preferences sync. The interface stays in English. Secrets, plugin approvals, safety settings, programs, and backups stay on this PC.",
    "syncDisabled": "Preference sync is off. Choose a folder and enable it before transferring preferences.",
    "syncFirstConnection": "A shared copy already exists. Nothing was overwritten. Choose which copy to use.",
    "syncConflict": "Both copies changed. Review the choices before replacing either copy.",
    "syncNoConflict": "No conflicting preference changes were detected.",
    "syncPullTitle": "Use shared preferences",
    "syncPullBody": "Apply the portable preferences from the shared folder to this PC. Machine-specific settings stay here.",
    "syncPullAction": "Pull to this PC…",
    "syncPushTitle": "Use this PC’s preferences",
    "syncPushBody": "Replace the shared portable preferences with the preferences on this PC.",
    "syncPushAction": "Push to shared folder…",
    "syncPullConfirm": "Apply the shared preferences to this PC?",
    "syncPushConfirm": "Replace the shared preferences with this PC’s copy?",
    "syncUnresolved": "Sync still needs a choice for: {fields}",
    "syncComplete": "Preferences synced. No program or backup was transferred.",
    "recoveryReviewTitle": "Interrupted operation needs review",
    "recoveryReviewBody": "Windows may have changed this item before Purgeon recorded the outcome. Automatic rollback and replay are disabled to avoid changing the wrong data.",
    "recoveryOperation": "Operation",
    "recoveryTarget": "Target",
    "recoveryRetained": "Closing this window keeps the operation journal and available backups. Review the target and backup before attempting manual recovery.",
    "languageChanged": "Language changed to {language}. Untranslated text falls back to English.",
    "searchCommand": "Search {items} or type a command",
    "sortColumn": "Sort by {column}. Activate again to reverse the order.",
    "selectedCount": {
      "one": "{count} item selected",
      "other": "{count} items selected"
    },
    "noSelection": "Select a program to inspect it. Double-click opens details.",
    "rowCount": {
      "one": "{count} entry",
      "other": "{count} entries"
    }
  }, ...{
    "rowInspectHint": "Double-click opens details. Use an explicit action to change or remove items. Ctrl+click or Shift+click selects several.",
    "selectionFraction": "{selected} of {total} selected",
    "progressFraction": "{current} of {total}"
  } };

export const language = () => 'en';
export const languages = () => [{ code: 'en', name: 'English' }];
// Kept for application/backend API compatibility; English never switches at runtime.
export const subscribeLanguage = () => () => {};
export async function resolveLanguage() {
  const settings = await readSettings();
  if (settings.language && settings.language !== 'en') await writeSettings({ language: 'en' });
  if (typeof document !== 'undefined') document.documentElement.lang = 'en';
  return 'en';
}
export async function persistLanguage(code) {
  if (code !== 'en') throw new Error('Purgeon supports English only. Use language code en.');
  await writeSettings({ language: 'en' });
}
export async function setLanguage(code) {
  await persistLanguage(code);
  return { language: 'en' };
}
function interpolate(value, params) {
  if (!params) return String(value);
  return String(value).replace(/\{(\w+)\}/g, (token, name) => params && typeof params === 'object' && Object.hasOwn(params, name) ? String(params[name]) : token);
}
export function t(key, params) {
  let value = Object.hasOwn(EN, key) ? EN[key] : key;
  if (typeof value === 'function') value = value(params);
  if (value && typeof value === 'object') value = value[new Intl.PluralRules('en').select(Number(params?.count) || 0)] ?? value.other;
  return interpolate(value, params);
}
export function tx(english, params) {
  return typeof english === 'string' ? interpolate(english, params) : english ?? '';
}
export function tHtml(key, params) {
  return t(key, params).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
