// Localization: UI strings externalized so Purgeon can run in more than one language.
// English is built in; other languages live in the same file as translation tables.
// The user's language is detected from Windows and stored in settings.
// All user-facing strings go through t(); nothing is hard-coded in UI code.
import { sys } from './sys.js';
import { readSettings } from './api.js';

const LOCALE = {
  // ---- English (default) ----
  en: {
    language: 'English',
    // App
    appName: 'Purgeon',
    appTagline: 'Windows uninstaller with leftover scanning, install monitoring and backups',
    // Views
    viewPrograms: 'Programs',
    viewApps: 'Apps',
    viewMonitored: 'Monitored Programs',
    viewStartup: 'Startup & Services',
    viewDebloat: 'Debloat',
    viewJunk: 'Cleaner',
    viewSnapshots: 'Snapshots',
    viewTimeline: 'Change Timeline',
    viewArchive: 'Uninstall Archive',
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
    settingsSafeMode: 'Safe mode (only near-certain matches)',
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
  },
  // ---- Spanish ----
  es: {
    language: 'Español',
    appName: 'Purgeon',
    appTagline: 'Desinstalador de Windows con análisis de restos, monitorización de instalaciones y copias de seguridad',
    viewPrograms: 'Programas',
    viewApps: 'Aplicaciones',
    viewMonitored: 'Programas monitorizados',
    viewStartup: 'Inicio y Servicios',
    viewDebloat: 'Debloat',
    viewJunk: 'Limpiador',
    viewSnapshots: 'Instantáneas',
    viewTimeline: 'Línea de Cambios',
    viewArchive: 'Archivo de Desinstalación',
    actionUninstall: 'Desinstalar',
    actionForce: 'Forzar',
    actionAnalyze: 'Analizar',
    actionSheet: 'Hoja',
    actionBackup: 'Copia de seguridad',
    actionQueue: 'Cola',
    actionGroup: 'Grupo',
    actionHide: 'Ocultar',
    actionUnhide: 'Mostrar',
    actionFolder: 'Carpeta',
    actionRegistry: 'Registro',
    actionSearch: 'Buscar',
    actionProperties: 'Propiedades',
    statusReady: 'Listo',
    statusScanning: 'Escaneando…',
    statusRemoving: 'Eliminando…',
    statusDone: 'Hecho',
    statusError: 'Error',
    settingsTitle: 'Configuración',
    settingsLanguage: 'Idioma',
    settingsSilentUninstall: 'Desinstalación silenciosa cuando sea posible',
    settingsSafeMode: 'Modo seguro (solo coincidencias casi seguras)',
    settingsCreateRestorePoints: 'Crear un punto de restauración antes de los cambios',
    settingsBackupMaxDays: 'Mantener copias de seguridad no más antiguas de (días, 0 = ilimitado)',
    settingsBackupMaxMB: 'Mantener copias de seguridad no más grandes de (MB, 0 = ilimitado)',
    settingsGridLines: 'Mostrar líneas de cuadrícula',
    settingsStartWithWindows: 'Iniciar Purgeon con Windows',
    settingsMonitoring: 'Monitorización en segundo plano',
    settingsScanLeftovers: 'Buscar restos de programas desinstalados fuera de Purgeon',
    settingsCheckStartup: 'Alertar en nuevas entradas de inicio',
    settingsSyncFolder: 'Sincronizar configuración a una carpeta (OneDrive, Dropbox, Google Drive…)',
    settingsSyncFolderPick: 'Elegir carpeta de sincronización…',
    settingsSyncFolderClear: 'Borrar carpeta de sincronización',
    cmdSnapshot: 'Tomar una instantánea',
    cmdRestorePoint: 'Crear un punto de restauración',
    cmdAssociations: 'Búsqueda de asociación de archivos',
    cmdSchedule: 'Monitorización programada',
    cmdPlugins: 'Gestionar complementos',
    cmdProfiler: 'Analizador de inicio',
    ok: 'Aceptar',
    cancel: 'Cancelar',
    yes: 'Sí',
    no: 'No',
    confirm: 'Confirmar',
    backup: 'Copia de seguridad',
    undo: 'Deshacer',
    restart: 'Reiniciar',
    restartLater: 'Reiniciar después',
    never: 'Nunca',
    more: 'Más',
    less: 'Menos',
    none: 'Ninguno',
    all: 'Todos',
    search: 'Buscar',
    filter: 'Filtrar',
    sort: 'Ordenar',
    size: 'Tamaño',
    date: 'Fecha',
    name: 'Nombre',
    publisher: 'Editor',
    version: 'Versión',
    arch: 'Arquitectura',
    installedOn: 'Instalado el',
    removedOn: 'Eliminado el',
    backedUpOn: 'Copiado el',
    takenOn: 'Tomado el',
    entries: 'Entradas',
    items: 'Elementos',
    programs: 'Programas',
    noResults: 'Sin resultados.',
    yesNo: (v) => (v ? 'Sí' : 'No'),
    onOff: (v) => (v ? 'Activado' : 'Desactivado'),
    enabledDisabled: (v) => (v ? 'Habilitado' : 'Deshabilitado'),
  },
  // ---- German ----
  de: {
    language: 'Deutsch',
    appName: 'Purgeon',
    appTagline: 'Windows-Deinstallationsprogramm mit Restesuche, Installationsüberwachung und Backups',
    viewPrograms: 'Programme',
    viewApps: 'Apps',
    viewMonitored: 'Überwachte Programme',
    viewStartup: 'Start & Dienste',
    viewDebloat: 'Debloat',
    viewJunk: 'Reiniger',
    viewSnapshots: 'Snapshots',
    viewTimeline: 'Änderungsverlauf',
    viewArchive: 'Deinstallationsarchiv',
    actionUninstall: 'Deinstallieren',
    actionForce: 'Erzwingen',
    actionAnalyze: 'Analysieren',
    actionSheet: 'Übersicht',
    actionBackup: 'Sichern',
    actionQueue: 'Warteschlange',
    actionGroup: 'Gruppe',
    actionHide: 'Ausblenden',
    actionUnhide: 'Einblenden',
    actionFolder: 'Ordner',
    actionRegistry: 'Registrierung',
    actionSearch: 'Suchen',
    actionProperties: 'Eigenschaften',
    statusReady: 'Bereit',
    statusScanning: 'Wird gescannt…',
    statusRemoving: 'Wird entfernt…',
    statusDone: 'Fertig',
    statusError: 'Fehler',
    settingsTitle: 'Einstellungen',
    settingsLanguage: 'Sprache',
    settingsSilentUninstall: 'Stille Deinstallation, wenn möglich',
    settingsSafeMode: 'Sicherer Modus (nur nahezu sichere Treffer)',
    settingsCreateRestorePoints: 'Wiederherstellungspunkt vor Änderungen erstellen',
    settingsBackupMaxDays: 'Backups nicht älter als (Tage, 0 = unbegrenzt)',
    settingsBackupMaxMB: 'Backups nicht größer als (MB, 0 = unbegrenzt)',
    settingsGridLines: 'Rasterlinien anzeigen',
    settingsStartWithWindows: 'Purgeon mit Windows starten',
    settingsMonitoring: 'Hintergrundüberwachung',
    settingsScanLeftovers: 'Nach Resten von Programmen suchen, die anderswo entfernt wurden',
    settingsCheckStartup: 'Bei neuen Starteinträgen alarmieren',
    settingsSyncFolder: 'Einstellungen in einen Ordner synchronisieren (OneDrive, Dropbox, Google Drive…)',
    settingsSyncFolderPick: 'Sync-Ordner wählen…',
    settingsSyncFolderClear: 'Sync-Ordner löschen',
    cmdSnapshot: 'Snapshot erstellen',
    cmdRestorePoint: 'Wiederherstellungspunkt erstellen',
    cmdAssociations: 'Dateizuordnungs-Lookup',
    cmdSchedule: 'Geplante Überwachung',
    cmdPlugins: 'Plugins verwalten',
    cmdProfiler: 'Start-Profiler',
    ok: 'OK',
    cancel: 'Abbrechen',
    yes: 'Ja',
    no: 'Nein',
    confirm: 'Bestätigen',
    backup: 'Backup',
    undo: 'Rückgängig',
    restart: 'Neustart',
    restartLater: 'Später neu starten',
    never: 'Nie',
    more: 'Mehr',
    less: 'Weniger',
    none: 'Keine',
    all: 'Alle',
    search: 'Suchen',
    filter: 'Filter',
    sort: 'Sortieren',
    size: 'Größe',
    date: 'Datum',
    name: 'Name',
    publisher: 'Herausgeber',
    version: 'Version',
    arch: 'Architektur',
    installedOn: 'Installiert am',
    removedOn: 'Entfernt am',
    backedUpOn: 'Gesichert am',
    takenOn: 'Erstellt am',
    entries: 'Einträge',
    items: 'Elemente',
    programs: 'Programme',
    noResults: 'Keine Ergebnisse.',
    yesNo: (v) => (v ? 'Ja' : 'Nein'),
    onOff: (v) => (v ? 'An' : 'Aus'),
    enabledDisabled: (v) => (v ? 'Aktiviert' : 'Deaktiviert'),
  },
  // ---- French ----
  fr: {
    language: 'Français',
    appName: 'Purgeon',
    appTagline: 'Désinstalleur Windows avec analyse des résidus, surveillance des installations et sauvegardes',
    viewPrograms: 'Programmes',
    viewApps: 'Applis',
    viewMonitored: 'Programmes surveillés',
    viewStartup: 'Démarrage & Services',
    viewDebloat: 'Debloat',
    viewJunk: 'Nettoyeur',
    viewSnapshots: 'Instantanés',
    viewTimeline: 'Historique des modifications',
    viewArchive: 'Archive de désinstallation',
    actionUninstall: 'Désinstaller',
    actionForce: 'Forcer',
    actionAnalyze: 'Analyser',
    actionSheet: 'Feuille',
    actionBackup: 'Sauvegarder',
    actionQueue: 'File d\'attente',
    actionGroup: 'Groupe',
    actionHide: 'Masquer',
    actionUnhide: 'Afficher',
    actionFolder: 'Dossier',
    actionRegistry: 'Registre',
    actionSearch: 'Rechercher',
    actionProperties: 'Propriétés',
    statusReady: 'Prêt',
    statusScanning: 'Analyse en cours…',
    statusRemoving: 'Suppression en cours…',
    statusDone: 'Terminé',
    statusError: 'Erreur',
    settingsTitle: 'Paramètres',
    settingsLanguage: 'Langue',
    settingsSilentUninstall: 'Désinstallation silencieuse si possible',
    settingsSafeMode: 'Mode sécurisé (correspondances quasi-certaines uniquement)',
    settingsCreateRestorePoints: 'Créer un point de restauration avant les modifications',
    settingsBackupMaxDays: 'Conserver les sauvegardes de moins de (jours, 0 = illimité)',
    settingsBackupMaxMB: 'Conserver les sauvegardes de moins de (Mo, 0 = illimité)',
    settingsGridLines: 'Afficher les lignes de grille',
    settingsStartWithWindows: 'Lancer Purgeon avec Windows',
    settingsMonitoring: 'Surveillance en arrière-plan',
    settingsScanLeftovers: 'Rechercher les résidus de programmes désinstallés ailleurs',
    settingsCheckStartup: 'Alerter sur les nouveaux entrées de démarrage',
    settingsSyncFolder: 'Synchroniser les paramètres vers un dossier (OneDrive, Dropbox, Google Drive…)',
    settingsSyncFolderPick: 'Choisir le dossier de synchronisation…',
    settingsSyncFolderClear: 'Effacer le dossier de synchronisation',
    cmdSnapshot: 'Prendre un instantané',
    cmdRestorePoint: 'Créer un point de restauration',
    cmdAssociations: 'Recherche d\'association de fichiers',
    cmdSchedule: 'Surveillance planifiée',
    cmdPlugins: 'Gérer les extensions',
    cmdProfiler: 'Profileur de démarrage',
    ok: 'OK',
    cancel: 'Annuler',
    yes: 'Oui',
    no: 'Non',
    confirm: 'Confirmer',
    backup: 'Sauvegarde',
    undo: 'Annuler',
    restart: 'Redémarrer',
    restartLater: 'Redémarrer plus tard',
    never: 'Jamais',
    more: 'Plus',
    less: 'Moins',
    none: 'Aucun',
    all: 'Tous',
    search: 'Rechercher',
    filter: 'Filtrer',
    sort: 'Trier',
    size: 'Taille',
    date: 'Date',
    name: 'Nom',
    publisher: 'Éditeur',
    version: 'Version',
    arch: 'Architecture',
    installedOn: 'Installé le',
    removedOn: 'Supprimé le',
    backedUpOn: 'Sauvegardé le',
    takenOn: 'Pris le',
    entries: 'Entrées',
    items: 'Éléments',
    programs: 'Programmes',
    noResults: 'Aucun résultat.',
    yesNo: (v) => (v ? 'Oui' : 'Non'),
    onOff: (v) => (v ? 'Activé' : 'Désactivé'),
    enabledDisabled: (v) => (v ? 'Activé' : 'Désactivé'),
  },
};

const DEFAULT_LANG = 'en';
const LANGUAGE_SETTING = 'language';

// Detect the user's Windows locale and map it to a supported language, falling back to English.
function detectLanguage() {
  const locale = (sys.env('LANGUAGE') || sys.env('LC_ALL') || sys.env('LC_CTYPE') || sys.env('USERNAME') || '').toLowerCase();
  // Windows locale names look like en-US, de-DE, es-ES, fr-FR.
  const m = locale.match(/^(en|es|de|fr)[-_]/);
  if (m && LOCALE[m[1]]) return m[1];
  // Also accept plain two-letter codes.
  for (const code of Object.keys(LOCALE)) {
    if (locale === code || locale.startsWith(`${code}-`)) return code;
  }
  return DEFAULT_LANG;
}

let current = DEFAULT_LANG;

// Resolve the language: saved setting, then detected Windows locale, then English.
export async function resolveLanguage() {
  try {
    const s = await readSettings();
    if (s.language && LOCALE[s.language]) {
      current = s.language;
      return current;
    }
  } catch {}
  current = detectLanguage();
  return current;
}

export function language() {
  return current;
}

export function languages() {
  return Object.entries(LOCALE).map(([code, table]) => ({ code, name: table.language }));
}

export async function setLanguage(code) {
  if (!LOCALE[code]) throw new Error(`Unknown language: ${code}`);
  current = code;
  await persistLanguage(code);
  return { language: code };
}

// Persist language choice to settings.json.
export async function persistLanguage(code) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const file = path.join(sys.info.dataDir, 'settings.json');
  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  settings.language = code;
  fs.writeFileSync(file, JSON.stringify(settings, null, 2));
}

export function t(key, params) {
  const table = LOCALE[current] || LOCALE[DEFAULT_LANG];
  let value = table[key] || LOCALE[DEFAULT_LANG][key] || key;
  if (typeof value === 'function') value = value(params);
  return value;
}

export function tHtml(key, params) {
  return t(key, params);
}
