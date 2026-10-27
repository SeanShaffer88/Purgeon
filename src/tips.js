// Tooltips: what each command and button does, said plainly, including what it changes and how to
// undo it. ACTION_TIPS is keyed by the action a menu item, right-click entry, action-bar button or
// palette entry runs; LABEL_TIPS by a dialog button's text. installTips() gives every button, check
// box and field without a tooltip of its own the matching one, as the UI changes.

export const ACTION_TIPS = {
  // File
  export: 'Saves the list as it is shown now (name, version, publisher, size, date, folder) as an HTML page you choose where to save. Nothing on the PC changes.',
  report: 'Saves an HTML report of one month: programs installed and removed, space freed, startup changes, updates, clean-ups and programs flagged by the insights. Read-only.',
  migratePc: 'Packs the programs you choose into one folder (one package each, with or without your settings), plus a winget list of all your programs, to set up another PC. Nothing on this PC changes.',
  restoreFolder: 'Restores program packages from a folder made with Migrate This PC. Nothing existing is overwritten, and each restore can be undone from Change History.',
  sync: 'Keeps chosen programs’ settings the same on your PCs through a shared folder (for example in OneDrive). Settings being replaced go to the Recycle Bin first.',
  elevate: 'Starts Purgeon again with administrator rights (Windows asks first). Needed to remove programs installed for all users and for machine-wide changes.',
  quit: 'Closes Purgeon completely, including its tray icon. A monitored installation in progress can be resumed next time.',
  // Action
  uninstall: 'Runs the program’s own uninstaller (silently when that is turned on and supported), then scans for what it left behind and lets you choose what to remove. Everything removed is backed up first.',
  force: 'For programs whose uninstaller is missing or broken: skips the uninstaller, finds the program’s files, settings, services and tasks, and removes the ones you choose, with a backup.',
  analyze: 'Shows what belongs to the program (folders, registry keys, services, tasks, shortcuts) without uninstalling anything. You can remove leftovers from there, with a backup.',
  queueAdd: 'Adds the program to the uninstall queue, which uninstalls programs one after another without you watching (Tools › Uninstall Queue to start it).',
  rescue: 'For a broken uninstaller: reinstalls the program through winget over the existing copy, which puts a working uninstaller back, then uninstalls it normally. Asks first.',
  removeEntry: 'Removes only the program’s entry from the installed-programs list (its uninstall registry key, backed up first). Use this for entries left behind by programs that are already gone. Files are not touched.',
  analyzeProgram: 'A one-page report on the program (Ctrl+I): how it was installed and can be removed, disk space with its data folders, what it hooks into Windows, whether it is running, when it was last used, what needs it, its signature and architecture. Read-only.',
  sheet: 'What’s This (Ctrl+W): one page listing everything the program hooks into Windows: services, tasks, startup entries, firewall rules, file types, Explorer menus, folders and registry settings. Read-only.',
  setGroup: 'Files the selected programs under a group name of your choice (for example Games or Work), shown as a tag. Groups only affect Purgeon’s list; undo from Change History.',
  backupProgram: 'Packs the program into one .swpkg file, with or without your settings, to back it up or move it to another PC. Nothing on this PC changes.',
  registry: 'Opens Registry Editor at the program’s uninstall entry. Read-only unless you change something there yourself.',
  folder: 'Opens the program’s install folder in Explorer.',
  search: 'Searches the web for the program’s name in your default browser.',
  properties: 'Shows everything known about the program: uninstall command, folder, signer, installer type, what it was installed with, and its size history.',
  hide: 'Hides the selected programs from Purgeon’s list. They stay installed and Windows still lists them; only this list hides them. View › Show Hidden Programs and Action › Unhide bring them back.',
  unhide: 'Shows the selected hidden programs in the list normally again.',
  clearSelection: 'Deselects all selected programs.',
  // View
  'view:desktop': 'Programs installed on this PC, from all three uninstall locations (64-bit, 32-bit and per-user).',
  'view:store': 'Apps from the Microsoft Store and other packaged apps installed for your user.',
  'view:monitored': 'Programs whose installation Purgeon recorded. Uninstalling one removes exactly what its installation created.',
  'view:debloat': 'Safe, reversible Windows tweaks: ads, telemetry, suggestions, taskbar and Explorer settings. Each can be turned back off.',
  'view:startup': 'Everything that runs without you starting it: Run entries, startup shortcuts, scheduled tasks and services. Turning one off never deletes it.',
  'view:junk': 'Temporary files, caches, crash dumps and other files Windows and programs recreate. Cleaned files go to the Recycle Bin.',
  'view:archive': 'A permanent record of every program removed, with how, when, and its backups. Reinstall or put leftovers back from here.',
  'view:timeline': 'Everything that changed on this PC that Purgeon knows of, newest first: installs, removals, snapshots, trials and changes.',
  'view:backups': 'Every removal’s backup. Double-click one to restore what it removed.',
  'view:history': 'Every change Purgeon made, newest first. Double-click a change to undo it.',
  'view:snapshots': 'Saved records of your files and registry. Compare two, or one with now, to see exactly what changed.',
  diskMap: 'Draws each program as a block sized by its install folder plus its data folders, to show where disk space goes. Read-only; takes a little while to measure.',
  palette: 'Opens a searchable list of every command and every program (Ctrl+K). Type, then press Enter.',
  find: 'Moves the cursor to the search box above the list (Ctrl+F). The box also finds commands.',
  refresh: 'Reads the list again from Windows (F5), for example after installing something.',
  zoomIn: 'Makes everything larger (Ctrl++).',
  zoomOut: 'Makes everything smaller (Ctrl+-).',
  zoomReset: 'Back to the normal size (Ctrl+0).',
  toggleGrid: 'Shows or hides the lines between rows and columns.',
  'theme:dark': 'The dark terminal-style theme.',
  'theme:light': 'A light theme with dark text.',
  'theme:contrast': 'High contrast: white on black with strong outlines, for easier reading.',
  toggleHidden: 'Shows programs you hid, dimmed and tagged "hidden", so you can unhide them. Turn it off to hide them again.',
  toggleOnTop: 'Keeps the Purgeon window in front of other windows, even when you click elsewhere.',
  toggleMinTray: 'When you minimize the window, it leaves the taskbar and waits in the notification area (tray). Left-click the tray icon to bring it back; right-click it for its menu.',
  'close:ask': 'The close button asks whether to exit or keep Purgeon running in the tray (the default).',
  'close:tray': 'The close button keeps Purgeon running in the notification area (tray), so it can still spot installers and new startup entries. Exit from the tray icon’s right-click menu.',
  'close:exit': 'The close button exits Purgeon completely.',
  toggleTray: 'When you close the window, Purgeon keeps running in the notification area (tray), so it can still spot installers and new startup entries. Exit from the tray menu.',
  toggleStartTray: 'Purgeon starts hidden in the notification area (tray) instead of opening its window. Left-click the tray icon to open it.',
  toggleAutostart: 'Starts Purgeon when you sign in to Windows, through a scheduled task in Task Scheduler › Purgeon (needed because it runs as administrator). Off by default; turning it off deletes the task.',
  schedule: 'Turns background monitoring on or off. When on, Purgeon runs quietly while the PC is idle: scans for leftovers of programs removed elsewhere and watches for new startup entries. Results appear in Change History.',
  syncFolder: 'Chooses the shared folder (for example inside OneDrive, Dropbox or Google Drive) where Purgeon mirrors its settings so they are the same on your PCs.',
  language: 'Switches Purgeon’s menus, buttons and messages between English, Spanish, German and French. Restart Purgeon for every menu to use the new language.',
  // Tools
  monitor: 'Records everything an installer creates or changes, using a snapshot before and after (and live tracking as administrator), so the program can be removed completely later.',
  toggleDetect: 'Watches for installers starting while Purgeon runs (also from the tray) and asks whether to record them. Nothing is recorded unless you say yes.',
  trials: 'Try a program and undo it completely: a snapshot is taken, you install and use it, then Try Over removes everything added since, after showing you the list.',
  queue: 'Shows the uninstall queue: programs uninstalled one after another without watching, continuing after a restart if needed. All leftovers are reviewed at the end.',
  takeSnapshot: 'Records your files, folders and registry settings now, to compare with later. Quick takes seconds; Deep takes longer.',
  restoreProgram: 'Restores a program from a .swpkg package (made with Migrate / Back Up Program). Nothing existing is overwritten, and the restore can be undone.',
  whoOwns: 'Tells you which installed program a file, folder or registry key belongs to, and how sure it is. Read-only.',
  orphans: 'Looks for folders, registry keys and services of programs that are no longer installed. Nothing is pre-selected; Dry Run shows what a removal would do.',
  regSearch: 'Searches the registry’s Software branches for keys and values mentioning a word. Results start unticked, follow the protection rules and are backed up before removal.',
  portable: 'Finds programs that run without being installed, and lets you register them so they get an icon, groups and leftover scans like installed programs.',
  browsers: 'Lists browser extensions and search settings in Chrome, Edge, Brave and Firefox, and flags extensions that a program added on its own. Those can be removed, with a backup.',
  updates: 'Lists programs with newer versions in winget (the Windows Package Manager) and updates the ones you choose.',
  exportWinget: 'Saves your programs as a winget list. On another PC, "winget import" installs them all. Nothing on this PC changes.',
  maintenance: 'A weekly scheduled task that takes a snapshot, cleans the junk you choose (to the Recycle Bin) and applies backup limits. It never uninstalls anything.',
  toggleRestore: 'When on, uninstall and tweak confirmations offer to create a Windows restore point first (the box starts ticked).',
  toggleSilent: 'When on, Windows Installer, Inno Setup, NSIS and WiX uninstallers run without their windows. Other uninstallers show their window as usual.',
  toggleSafe: 'When on, leftover lists offer only near-certain matches (90% or more), and never services, scheduled tasks or firewall rules.',
  toggleShell: 'Adds "Uninstall with Purgeon" and "Who owns this?" to Explorer’s right-click menu, for your user only. Turning it off removes exactly those entries.',
  ctxmenu: 'Lists the right-click entries other programs added to Explorer, and turns them off or on without deleting them.',
  backupSettings: 'Limits how much space and how long backups are kept. Each program’s newest backup is always kept.',
  confirmationPrompts: 'Manage which confirmation prompts are skipped. Prompts you disabled with "Don\'t show again" are listed here and can be restored.',
  openLog: 'Opens the log of every command Purgeon ran in the last 14 days, with its result.',
  portableapps: 'Creates a PortableApps.com installer (.paf.exe) from a program you monitored with Tools › Monitor an Installation. Purgeon copies the recorded program files into a PortableApps.com folder structure and writes an NSIS installer script you compile with makensis.',
  startupDelayed: 'Automatic (Delayed Start) lets the service begin a short while after boot instead of at boot, speeding up sign-in. Only for services set to Automatic.',
  trustedPublishers: 'Manage the trusted publisher allowlist. Programs digitally signed by a listed publisher are never blocked by Safe Mode and are excluded from unsigned-program warnings. Add the certificate subject name as shown in the program’s digital signature.',
  updateCheck: 'Purgeon can optionally ask GitHub whether a newer release exists. Off by default; turn it on in Settings. It sends only a standard HTTPS request to api.github.com and never nags after a dismissal.',
  about: 'Version, license and where Purgeon keeps its data.',
  // Other lists
  undoChange: 'Undoes this change, using the backup taken when it was made.',
  reinstall: 'Installs this program again through winget, if winget knows it.',
  openSite: 'Opens the publisher’s website in your browser.',
  restoreRemoval: 'Puts back the leftovers that were removed with this program, from its backup.',
  deleteRecord: 'Deletes this entry from the archive. Its backups stay in Backups.',
  compareNow: 'Compares the selected snapshot with the system as it is now, and lists what was added, removed and changed.',
  compareSelected: 'Compares the two selected snapshots (Ctrl+click to select two).',
  deleteSnapshot: 'Deletes the selected snapshot file. Your files and settings are not touched.',
  restore: 'Restores what this backup holds: files from the Recycle Bin, registry keys, services, tasks and firewall rules.',
  deleteBackup: 'Deletes this backup permanently. What it removed can then no longer be restored from it.',
};

// Dialog and view buttons, by their text (without a trailing "…" or "...").
export const LABEL_TIPS = {
  OK: 'Closes this message.',
  Close: 'Closes this window. Nothing else happens.',
  Cancel: 'Closes this window without changing anything.',
  'Not Now': 'Closes this window without doing anything. You can do it later from the menus.',
  'Decide Later': 'Closes this window. The entries stay as they are, and you can turn them off later in Startup & Services.',
  Yes: 'Goes ahead with what this window describes.',
  No: 'Does not go ahead; nothing changes.',
  Undo: 'Puts back what was just changed, from the backup taken before it.',
  'Back to the List': 'Closes this window and returns to the list.',
  'Select All': 'Ticks every item that can be selected.',
  'Select None': 'Unticks every item.',
  'Select Shown': 'Ticks every item the current filter shows.',
  'Delete Selected': 'Removes the ticked items. Each is backed up first and the removal can be undone from Change History.',
  'Export Plan': 'Saves this dry-run plan as a file, so you can review it later. Nothing is changed.',
  'Browse': 'Choose a file on this PC.',
  'File': 'Choose a file to look up.',
  'Folder': 'Choose a folder.',
  'Start Monitoring': 'Takes the "before" snapshot, then starts the installer you chose. Install as usual, then come back and click Installation Finished.',
  'Start (I will run the installer)': 'Takes the "before" snapshot. Then run the installer yourself, and come back and click Installation Finished.',
  'Installation Finished': 'Takes the "after" snapshot and records everything the installation created or changed, under Monitored Programs.',
  'Cancel Monitoring': 'Stops monitoring and discards the snapshots. Nothing is recorded and the installed program is not touched.',
  'Monitor It': 'Takes a snapshot now while the installer waits on its first page, then records what it installs. Don’t click Next in the installer until the snapshot is done.',
  'Stop Detecting': 'Turns off installer detection (Tools › Detect Installations turns it back on).',
  'Roll Back': 'Puts back everything this interrupted removal had already removed, from its backup.',
  'Finish Removal': 'Removes the rest of what this interrupted removal had planned, with the usual backups.',
  'Leave As Is': 'Leaves things as they are now. The backup of what was removed stays in Backups.',
  'Set Group': 'Files the selected programs under this group name.',
  'Remove from Group': 'Takes the selected programs out of their group.',
  'Minimize to Tray': 'Keeps Purgeon running in the notification area (tray); its window and taskbar button go away. Left-click the tray icon to bring it back.',
  Exit: 'Closes Purgeon completely.',
  'Clear Queue': 'Empties the uninstall queue. Nothing is uninstalled.',
  Start: 'Starts uninstalling the waiting programs one after another. If one needs a restart, Purgeon continues after you sign back in.',
  Continue: 'Continues with the programs still waiting in the queue.',
  Remove: 'Takes this entry out of the list. Nothing is uninstalled.',
  'Remove Selected': 'Removes the ticked extensions from the browser, after backing them up. Close the browser first.',
  'Start a Trial': 'Takes a snapshot and starts a trial install. Later, Try Over removes everything added since.',
  'Try Over': 'Shows everything added or changed since this trial began, then removes it and puts changed settings back, as if the program was never installed. Backed up first.',
  'Keep It': 'Ends the trial and keeps the program as installed. The trial’s snapshot is deleted, so Try Over is no longer possible.',
  'Scan for Leftovers': 'Scans for what the chosen programs left behind. You choose what to remove, with a backup.',
  'Allow All': 'Accepts all these new startup entries, so they are not reported again.',
  Allow: 'Accepts this startup entry, so it is not reported again.',
  'Turn Off': 'Stops this entry from starting with Windows without deleting it. Turn it back on in Startup & Services.',
  Register: 'Adds this portable program to the program list (a per-user uninstall entry marked as Purgeon’s).',
  Unregister: 'Removes the entry Purgeon added for this portable program. Its files are not touched.',
  'Add a Folder': 'Choose a folder that holds a portable program, to look for it there.',
  'Restart Explorer': 'Restarts Windows Explorer (the taskbar and folder windows) so right-click menu changes show everywhere. Open folder windows close.',
  'Save to Folder': 'Saves one package per chosen program, plus a winget list, into a folder you choose.',
  'Save Package': 'Saves the program as one .swpkg file where you choose.',
  'Save Report': 'Saves the monthly report as an HTML file where you choose.',
  Save: 'Saves these settings.',
  'Send My Settings': 'Copies the chosen programs’ settings from this PC to the shared folder.',
  'Get Settings': 'Brings in newer settings for the chosen programs from the shared folder. Current settings go to the Recycle Bin first.',
  Restore: 'Restores the chosen items, without overwriting anything that exists.',
  'Run Now': 'Runs the maintenance once now, with the options shown.',
  'Update Selected': 'Updates the ticked programs through winget, one after another, silently.',
  'Take Snapshot': 'Records your files, folders and registry settings now, under this name.',
  'Clean Up Selected': 'Removes the ticked added items and puts back ticked changed or removed settings from the earlier snapshot. Backed up and undoable.',
  Export: 'Saves this comparison as an HTML file.',
  'Analyze Leftovers': 'Shows what belongs to this program, without uninstalling it.',
  'Uninstall': 'Runs the program’s own uninstaller, then scans for leftovers. Everything removed is backed up first.',
  'What’s This': 'Lists everything this program hooks into Windows.',
  'Dry Run': 'Shows exactly what would be removed or skipped, item by item, without changing anything.',
  'Remove rule': 'Removes this inbound firewall rule after backing it up; it can be restored from Change History.',
  'Show more': 'Shows more items of this list.',
};

const clean = (s) => String(s || '').replace(/\s+/g, ' ').replace(/(…|\.\.\.)$/, '').replace(/^[»›✓\s]+/, '').trim();

export function tipForLabel(text) {
  const t = clean(text);
  if (LABEL_TIPS[t]) return LABEL_TIPS[t];
  // "Restore 3", "Show more (40 left)", "Clean 1.2 GB…": match on the first words.
  const hit = Object.keys(LABEL_TIPS).find((k) => t.startsWith(`${k} `) || t.startsWith(`${k} (`));
  return hit ? LABEL_TIPS[hit] : '';
}

// Keeps tooltips on everything: controls without a title of their own get one from LABEL_TIPS.
export function installTips(root = document.body) {
  const apply = (el) => {
    if (el.title || el.dataset.tipChecked === el.textContent) return;
    el.dataset.tipChecked = el.textContent;
    const tip = tipForLabel(el.innerText || el.textContent || el.getAttribute('aria-label'));
    if (tip) el.title = tip;
  };
  const scan = () => root.querySelectorAll('button, [role="option"], label.preset').forEach(apply);
  let queued = false;
  const observer = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      scan();
    });
  });
  observer.observe(root, { childList: true, subtree: true, characterData: true });
  scan();
  return () => observer.disconnect();
}
