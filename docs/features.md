# Purgeon — Features

Purgeon is a Windows uninstaller that removes a program and then finds the files, folders, registry keys, startup entries and services it left behind. Every change is backed up first and can be undone.

It runs on Windows 10 and 11 (64-bit). The full app is a **4.0 MB** executable in a **1.5 MB** installer, built with Tauri and React on Windows' built-in WebView2.

## Core uninstall and leftovers

**Uninstall** — Purgeon runs the program's own uninstaller and waits for it to finish, including Inno Setup and NSIS uninstallers that relaunch themselves from `%TEMP%`. It recognises Windows Installer, Inno Setup, NSIS, WiX bundle and InstallShield installers.

**Installer records** — before uninstalling, Purgeon reads the exact list of files and settings the installer recorded (the Windows Installer package cache, or the Inno Setup uninstall log). Anything listed that is left behind is offered with a 95–100% match score.

**Silent uninstall** — Windows Installer, Inno Setup, NSIS and WiX uninstallers run without their windows when "Silent Uninstall When Possible" is on. Unknown uninstallers are never given guessed switches.

**Leftover scan** — after uninstalling, Purgeon scans:
- the install folder;
- folders named after the program or its publisher in Program Files, ProgramData and AppData;
- Start Menu and desktop shortcuts;
- `Software` registry keys, App Paths and startup Run entries;
- services, scheduled tasks and firewall rules;
- Explorer right-click entries, shell extensions, file types and URL handlers;
- data and cache folders named after the program's own executables.

**Choosing what to remove** — every item gets a match score from 0 to 100%. Items scoring 70% or more start ticked; weaker guesses start unticked. Publisher folders count only when named exactly after the publisher, so removing one Google program never offers another's folders.

**Force** (`Shift+Del`) handles programs whose uninstaller is broken or missing. **Rescue Broken Uninstall** reinstalls the program through winget over the existing copy, then uninstalls it normally. **Analyze Leftovers** (`Ctrl+L`) shows what belongs to a program without uninstalling it.

**Dependency warnings** — Purgeon warns before removing a shared runtime (Visual C++, .NET, Java, DirectX), a hardware driver, or a program that other installed programs registered a need for.

## Batch uninstall and uninstall queue

**Batch uninstall** — select several programs with `Ctrl+click`, `Shift+click`, `Shift+arrows` or `Ctrl+A`, then press `Del`. Each uninstaller runs in turn. Afterwards one combined leftover list shows every program's items, grouped by program. **Stop After This One** cancels the rest of the batch.

**Uninstall queue** — programs uninstall one after another, silently where possible, so you don't have to watch. If an uninstaller needs a restart, the queue is saved and Purgeon resumes after you sign back in. All leftovers are reviewed together at the end.

## Installation monitor and disposable test installs

**Monitor an installation** (`Ctrl+M`) — takes a snapshot before, runs your installer, takes a snapshot after, and records every file, folder, registry key, value and service added. Live tracking with Windows Event Tracing follows the installer and every process it starts when running as administrator.

**Monitored Programs** (`Ctrl+3`) — lists recordings. Uninstalling one removes exactly what its installation created, put back against a fresh snapshot.

**Detecting installations** — while Purgeon runs (including from the tray), it notices installers starting and offers to record them. **Monitor It** takes the "before" snapshot while the installer waits on its first page, then you install as usual and click **Installation Finished**.

**Disposable test install** — runs an installer and captures every change it makes without storing anything permanently:
- `--monitor test-install-start --installer setup.exe` — takes the before snapshot and launches the installer.
- `--monitor test-install-finish` — compares before/after and classifies for portable suitability.
- `--monitor revert-test-install` — removes every captured change using the backup system, leaving the system exactly as it was before.

Results can be kept (packaged as portable) or reverted (truly disposable).

## Portable packaging

**Portable apps** — finds programs that run from a folder without being installed, remembers your own portable-app folders, and checks for updates through winget.

**PortableApps.com packaging** (`--portableapps generate`) — copies a monitored program's recorded files into a PortableApps.com folder structure (App/AppInfo, App/<program>, Data) and writes an appinfo.ini, launcher.ini and NSIS installer script you compile with makensis.

**Portable suitability classification** — `classifyForPortable()` checks captured items for:
- services — not portable (system-wide);
- drivers (.sys) — not portable (kernel-level);
- scheduled tasks — not portable (run outside the app folder);
- licensing/activation data — not portable (machine-tied);
- files outside the app folder — not self-contained;
- App Paths registry keys — allowed (not licensing).

Programs matching any exclusion are rejected with a clear reason why.

## Trial installs

Try a program and undo it completely — a snapshot is taken, the installer runs, and you use the program as long as you like. **Try Over** removes everything added since the snapshot, including what the program created during the trial, and puts changed settings back. **Keep It** ends the trial and keeps the program installed.

## Advanced Tools

Tools › Advanced Tools holds the powerful tools, deliberately kept out of the main window:

- **Recovery Packages**: every removal backup with its verification state.
- **Shared Components**: the shared runtimes, shared install folders and shared files Purgeon keeps during removals.
- **Secure Erase**: overwrites files (zeros, random data, or three passes)
- **Games**: the games Steam, Epic and GOG report — Steam library files, Epic manifests and GOG registry entries — with each game's folder size and a total. A game whose files are already gone can have its leftover launcher entry cleaned up; the cleanup uses the standard backed-up removal, so it can be undone from the Archive. The program list also gains a Games built-in group (launcher install folders). and then deletes them so they cannot be undeleted. Files only — folders are expanded first, links and protected Windows locations are refused, and there is no backup or undo by design: the list is reviewed and the erase confirmed every time, with the SSD limitation stated in the window. Shared files come from the SharedDLLs counts Windows itself maintains; where Windows records how many programs use a file but not which ones, the window says so instead of guessing. A backup is proven restorable when it is made — its seal is checked, its stored exports are trial-restored into a scratch folder, and its Recycle Bin items are confirmed present — and the verdict is recorded beside the package (never inside it, so the record cannot break the package's own fingerprint). The window also restores single ticked items out of a package, and can re-verify any package on demand.

## Snapshots

**Snapshots** (`Ctrl+7`) — named records of Program Files, ProgramData, AppData, Start Menu and desktops, and the software and services parts of the registry. Temporary files and caches are left out. Depths: Quick, Standard, Deep.

**Timeline comparison** — click one snapshot, then Ctrl+click a second to compare them, or compare one with **Now**. A comparison shows what was added, removed and changed, with old and new registry values side by side. Filter by files or registry, search, export to HTML.

**Clean Up Selected** — removes added items and puts changed or removed registry values and keys back. Everything is backed up and undoable, and **Dry Run** shows what it would do first.

## Change timeline

**Timeline** (`Ctrl+T`) — joins installs and updates Windows recorded, monitored installs, trials and snapshots, removals (including programs removed outside Purgeon), and everything in Change History, newest first.

## Analyze a program

**Analyze** (`Ctrl+I`) — one read-only report: removal verdict (own uninstaller, silent or Force), whether it is running, whether other programs need it, signature status, whether it has gone unused for half a year, architecture, disk space (install folder plus data folders), last-used date from Prefetch, how it was installed, and what it hooks into Windows with counts per category.

## Disk space map

**Disk Space Map** — draws each program as a block sized by its install folder plus data folders named after it in ProgramData and AppData. Click a block to see its biggest folders, then open Analyze Leftovers.

## Program migration and settings sync

**Packaging** — right-click a program and choose **Migrate / Back Up Program** to pack it into one `.swpkg` file:
- **Program and my settings** — everything, to carry on where you left off;
- **Program only** — a clean copy without settings, history or sign-ins;
- **My settings only** — for a PC where the program is already installed.

Items are marked as part of the program (install folders, shortcuts, machine-wide settings, uninstall entry) or as your settings (AppData, documents, per-user registry). Nothing on this PC changes.

**Whole PC** — `File › Migrate This PC` packs chosen programs into one folder, one package each, plus a winget list of all programs. `File › Restore Programs From Folder` restores packages on another PC.

**Settings sync** — `File › Settings Sync` keeps chosen programs' settings the same on your PCs through a shared folder such as OneDrive. **Send My Settings** saves there; **Get Settings** brings in newer ones. Settings being replaced go to the Recycle Bin first and can be undone.

## Uninstall Archive

**Uninstall Archive** (`Ctrl+9`) — keeps a record of every program removed: when, how (uninstalled, force removed, Store app) and its removal backups. Right-click an entry to reinstall with winget, open its website, or put back removed leftovers.

## Who owns this?

**Tools › Who Owns This** — tells you which installed program a file, folder or registry key belongs to, and how sure it is. It checks install folders, uninstall entries, monitored installations, and names along the path. Windows' and hardware vendors' shared folders are recognised.

## Orphaned leftovers and registry search

**Find Orphaned Leftovers** — looks for folders, registry keys and services of programs no longer installed. Nothing is pre-selected. Windows' own folders, anything an installed program uses, anything used in the last 30 days, game saves in `AppData\LocalLow`, AppData folders (possibly settings/saved games), and folders containing programs (possibly portable) are excluded or flagged.

**Dry Run** — shows exactly what a removal would do, item by item, without changing anything.

**Search Registry** — finds registry keys named after a word, and values mentioning it, in the Software branches of your user and the machine. Results follow the same protection rules, start unticked, and are backed up before removal.

## Program updates

**Program Updates** — lists newer versions available through winget and updates the ones you choose, silently, one after another, with a restore point offered first.

**Export Program List** — saves your programs as a winget list. On a new PC, `winget import -i <file>` installs them all.

## Portable apps (registration)

**Portable Apps** — finds programs that run from a folder without being installed, so Windows doesn't list them. Looks in Program Files, `C:\PortableApps`, `C:\Tools`, `C:\Apps` and the same names in your user folder.

**Your own folders** — `Add a Folder` remembers a folder holding your portable apps, such as `D:\PortableApps`, and looks at it every time.

**Updates** — `Check for Updates` looks each app up in winget's catalogue and shows up to date, newer version available, or not in winget.

**Register** — adds one to the program list with its icon through a per-user uninstall entry marked as Purgeon's. It then gets groups, leftover scans and clean removal like any installed program. **Unregister** removes only that entry.

## Cleaner

**Cleaner** (`Ctrl+8`) — finds files Windows and programs recreate when needed, with sizes:
- temporary files (yours and Windows'), keeping anything used in the last day;
- crash dumps and Windows error reports;
- Explorer thumbnail cache and DirectX shader caches;
- downloaded Windows Update files and the Delivery Optimization cache;
- data folders of Microsoft Store apps no longer installed.

**Privacy traces** — offered too, but never selected for you: recent-files list, jump lists, icon cache. Only shortcuts and caches are removed, never the files they point to.

**Windows clean-up** — uses Windows' own tools for outdated WinSxS libraries, Windows.old, Windows Update clean-up, demo content, older system restore points (newest always kept). Permanent, never selected for you, needs administrator rights, own confirmation.

**How cleaning works** — cleaned items go to the Recycle Bin, files in use are skipped, the registry is never touched, only the contents of known folders are cleaned.

## Browser clean-up

**Browser Clean-up** — lists extensions, search engine and home page of Chrome, Edge, Brave and Firefox. Extensions a program added on its own (through the registry or into Firefox's shared folders) are flagged and can be removed with a backup. Extensions you added yourself are listed for reference only. Nothing is changed while the browser is running.

## Startup & Services

**Startup & Services** (`Ctrl+6`) — everything that runs without you starting it:
- Run entries and Startup-folder shortcuts;
- scheduled tasks outside Windows' own `\Microsoft\` folder;
- third-party services that start automatically;
- programs allowed incoming connections through the firewall.

For each entry: publisher, command, program it belongs to, digital signature, updater status, and seconds Windows measured adding to start-up.

**Turning an entry off never deletes it** — Run entries use Windows' own switch, tasks are disabled, services are set from Automatic to Manual with the original mode remembered. Microsoft entries are tagged **Windows** and ask before being turned off.

**Trust check** — entries worth a second look are tagged: running from a temporary/download/oddly-named user folder, unsigned, or added recently.

**New-entry alerts** — when a program adds itself to startup, Purgeon tells you with a Windows notification and offers Allow or Turn Off.

## Explorer context menu

**Explorer Context Menu Items** — lists right-click entries programs added to Explorer for files, folders, folder and desktop background, and drives. Windows' own entries are left out. Turn any one off or on; nothing is deleted (uses Windows' own `LegacyDisable` switch or shell-extension blocked list). Changes show in new Explorer windows or everywhere after **Restart Explorer**. Each is in Change History and can be undone.

**Purgeon's own entries** — adds **Uninstall with Purgeon** for shortcuts and programs, and **Who owns this?** for files and folders, for your user only.

## Debloat

**Debloat** (`Ctrl+5`) — 26 safe, reversible tweaks in five groups: Privacy & telemetry, Start/search/taskbar, Ads & suggestions, Explorer & UI, and Windows Update. Each is ENABLED or DISABLED; turning one off puts back exactly the previous value. Each says when it takes effect: Applies immediately, Needs Explorer restart, or Needs reboot. No service removal, no app removal, no security features turned off. Machine-wide policies are tagged Admin.

## Program groups

**Set Group** (`Ctrl+G`) — right-click programs and file them under a name such as Games, Work or Media. The group shows as a tag. The group list shows one group at a time, or only ungrouped programs, and searching matches group names. Group changes can be undone from Change History.

## Scheduled maintenance, tray and reports

**Scheduled Maintenance** — runs Purgeon once a week through Windows Task Scheduler: takes a Quick snapshot, cleans junk categories you choose to the Recycle Bin, applies backup limits. Never uninstalls anything and never runs permanent Windows clean-ups. Each run writes a short report and appears in Change History.

**Window and tray** (all in the View menu):
- **Always on Top** or the 📌 thumbtack keeps the window in front;
- **Minimize to Tray** hides the window in the notification area;
- **the close button** asks whether to Minimize to Tray or Exit, with a Remember my choice option;
- **Start Minimized to Tray** starts hidden;
- **Start with Windows** starts Purgeon at sign-in through Task Scheduler (runs as administrator without a UAC prompt).

**Tray icon** — left click shows the window; right click opens Show Purgeon, Monitor an Installation, Cleaner, Startup & Services, Program Updates and Exit. Reports finished maintenance runs, available updates, new startup entries and interrupted removals.

**Monthly Report** (`File › Monthly Report`) — saves an HTML page for a month: programs installed and removed, space freed, startup changes, updates, clean-ups, and programs flagged by the insights.

## Themes and accessibility

- **View** offers Dark terminal theme, Light theme and High Contrast.
- Every menu works from the keyboard: `Alt` plus a menu's underlined letter, arrow keys, `Enter`, `Esc`. Everything with focus shows a clear outline.
- Dialogs, menus, toolbars and lists carry roles and labels for screen readers.
- Skip-to-content link for keyboard users.
- Reduced-motion option respects `prefers-reduced-motion`.
- Font-size scaling in Settings.

## Safety, backups and undo

**Everything is backed up before it changes:** registry keys exported to `.reg` files, values recorded with type and data; scheduled tasks exported to XML; firewall rules and service definitions saved; files go to the Recycle Bin.

**Undo** — `Tools › Change History` (`Ctrl+H`) lists every change and undoes it with a double-click. `Tools › Backups` (`Ctrl+4`) restores any removal. After a removal, the report has an Undo button.

**Checks before anything is deleted** — Purgeon never offers drive roots, the Windows folder, your profile folder, install roots, or generic folders such as Microsoft or Common Files. It refuses to delete registry keys Windows depends on, Windows' own services, and scheduled tasks under `\Microsoft\`.

**Right before deleting** it checks again, and skips anything another installed program still uses, any file Windows counts as shared, and anything that changed after the scan. If that check can't run, nothing is deleted.

**Dry Run** shows exactly what a removal would do. **Safe Mode** offers only near-certain matches (90%+ confidence) and never services, tasks or firewall rules.

**Restore points** — before an uninstall, a batch or the first Debloat change, the confirmation offers to create one.

**Crash-safe removals** — each item is in the backup before the next one is removed. After a crash or power cut, the next start offers to roll back, finish or leave the removal.

**Fingerprinted backups** — backups are sealed with SHA-256 fingerprints; a changed backup is not restored. Backup Settings limits backups by age or size, always keeping each program's newest.

**Command log** — `Tools › Open Command Log` shows every command Purgeon ran with its result, for 14 days.

## Confirmation management

- **Disable confirmations** — any confirmation prompt can be dismissed with a "Don't show again" checkbox and is added to Settings › Confirmation Prompts.
- **Restore disabled confirmations** — re-enable any previously disabled prompt so it asks again before acting.
- **Confirmation prompts** — each shows what it does and how to undo it.

## Toggle selection

Clicking a program in the list selects it; clicking again deselects it. Works alongside Ctrl+click, Shift+click and Shift+arrows for multi-selection.

## Navigation

- **Back/Forward navigation** — View › Back and View › Forward move through the views you opened (Alt+Left / Alt+Right do the same).
- **View history** — Alt+Left/Right move back and forward through recently opened views.
- **Recent programs** — the last 10 programs you viewed or acted on are listed at the bottom of the View menu; picking one jumps back to it.
- **Command palette** (`Ctrl+K`) — fuzzy-search every command and program; prefix matches score highest.

## Progress feedback

Long operations (batch uninstall, leftover scanning, snapshot comparison) show a progress bar with percentage, items processed (X of Y), elapsed time, and pause/resume or cancel where supported.

## Error recovery

- **Error bar** — shows errors with a Retry button for recoverable failures.
- **Undo toast** — the last removal can be undone within 30 seconds.
- **Auto-retry** — backend calls retry up to 3 times on transient failures (file busy, registry locked, access denied, timeout).
- **Safe Mode** — Tools › Safe Mode turns safe mode on or off (only high-confidence matches are offered while it is on).
- **Batch uninstall pause/resume** — pause a batch uninstall mid-flight and resume later.

## Documentation and help

- **Welcome dialog** — 3-step welcome on first launch explaining what Purgeon does, safety guarantees (backups, undo), and guided starting paths; reopen with Help › Welcome Back.
- **First-run tips** — dismissible contextual tips (Ctrl+K, right-click, backups) with action buttons.
- **User Guide** (`Help › User Guide`) — common workflows: uninstall, monitor installation, clean junk, turn off startup entries.
- **Keyboard Shortcuts** (`Help › Keyboard Shortcuts`) — shortcuts organized by group.
- **What's New** — shown when a newer version is available, with a download link to releases.
- **Settings explanations** — plain-language descriptions for every setting in dialogs.
- **Settings export/import** — backup settings to JSON and restore from JSON.

## Command line

```bash
Purgeon --snapshot "Before installing X" [--preset quick|standard|deep]
Purgeon --compare <before> <after|now> [--report file.html|.json|.txt]
Purgeon --list-snapshots
Purgeon --timeline [--json]
Purgeon --history [--json]
Purgeon --archive [--json]
Purgeon --maintenance
Purgeon --monitor "<installer>" [--name "<program name>"]
Purgeon --monitor test-install-start --installer "<path>" [--name "<name>"]
Purgeon --monitor test-install-finish [--name "<name>"]
Purgeon --monitor revert-test-install
Purgeon --autostart on|off
Purgeon --background-scan
Purgeon --restore-point "<description>"
Purgeon --associations [--json]
Purgeon --associations-for "<program>" [--json]
Purgeon --schedule on|off [--scan-leftovers] [--check-startup] [--missed]
Purgeon --startup list|on|off|delayed|notdelayed --id <id>
Purgeon --trusted list|add|remove --name <publisher>
Purgeon --update settings|enable|disable|check
Purgeon --sync status|apply|now [--files settings.json]
Purgeon --plugins list|enable|disable|validate <id> [--json]
Purgeon --portableapps list
Purgeon --portableapps generate --monitor-id <id> --output <folder>
Purgeon --uninstall "<program name>"
Purgeon --language <code> [--json]
Purgeon --settings [--json]
Purgeon --help
```

**Options:** `--preset` is quick, standard (default) or deep. `--report` saves a comparison as HTML, JSON or plain text depending on extension. Exit code 0 on success, 1 on error.

## Limitations

- Snapshots record to a fixed depth (six levels for Standard, ten for Deep); live tracking covers any depth during monitored installs.
- Snapshots don't store file contents, so changed files are listed but can't be put back.
- Changes made by other programs during monitoring, or between snapshots, are listed too. Review before cleaning up.
- Files can be restored only while still in the Recycle Bin.
- A restored service comes back after a restart.

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `Del` | Uninstall (all selected programs when several are selected) |
| `Shift+Del` | Force removal |
| `Ctrl+L` | Analyze leftovers |
| `Ctrl+click` / `Shift+click` / `Shift+arrows` / `Ctrl+A` | Select several programs |
| `Alt+Enter` / `Enter` | Properties |
| `Ctrl+F` | Search, or type a command |
| `Ctrl+K` | Command palette |
| `Ctrl+G` | Set group |
| `Ctrl+Q` | Add to the uninstall queue |
| `Ctrl+I` | Analyze the selected program |
| `Ctrl+1` / `Ctrl+2` | Programs / Apps |
| `Ctrl+3` | Monitored Programs |
| `Ctrl+4` | Backups |
| `Ctrl+5` | Debloat |
| `Ctrl+6` | Startup & Services |
| `Ctrl+7` | Snapshots |
| `Ctrl+8` | Cleaner |
| `Ctrl+9` | Uninstall Archive |
| `Ctrl+T` | Change timeline |
| `Alt` + underlined letter | Open a menu |
| `Ctrl+M` | Monitor an installation |
| `Ctrl+H` | Change History |
| `Ctrl++` / `Ctrl+-` / `Ctrl+0` | Zoom in / out / reset |
| `Ctrl+S` | Export the list to HTML |
| `F5` | Refresh |

## Roadmap

Planned enhancements are listed in [docs/ROADMAP.md](ROADMAP.md).

## License

[MIT](https://github.com/SeanShaffer88/Purgeon/blob/main/LICENSE)
