# Roadmap

Planned enhancements, grouped by area. Each is meant to be built the same way as the rest of
Purgeon: original code, every change backed up and undoable, and nothing offered that
Windows or another installed program still needs.

## Released in 1.0.0

- **Uninstall queue.** Unattended uninstalls that continue after a restart, with all leftovers reviewed at the end.
- **Removed elsewhere.** Programs uninstalled outside Purgeon are noticed and offered a leftover scan.
- **Trial installs.** Try a program, then Try Over removes everything it and its installer added.
- **Rescue broken uninstalls.** Reinstall through winget to get a working uninstaller back, then uninstall.
- **Disk space map.** A treemap of the space each program and its data folders use.
- **Change timeline.** Installs, removals, snapshots, trials and Change History in one list.
- **What it does.** One page of everything a program hooks into Windows.
- **Registry search.** Keys and values that mention a word, under the leftover protection rules.
- **Startup trust check.** Entries from unusual folders, unsigned or newly added are tagged.
- **New startup entry alerts.** A notification with Allow and Turn Off when a program adds itself.
- **Browser clean-up.** Extensions that programs added to Chrome, Edge, Brave and Firefox, removable with a backup.
- **Whole-PC migration.** Several programs packed into one folder, plus a winget list for the rest.
- **Settings sync.** Chosen programs' settings kept in step through a shared folder.
- **Portable apps.** Programs without an installer can be registered to get icons, groups and leftover scans; your own folders of portable apps are remembered, and Check for Updates finds newer versions through winget.
- **Portable packaging.** Run installs in a disposable isolated test environment, capture every file and change, mark an app portable only when it runs from captured files without system-wide changes. Auto-exclude programs adding services, drivers, scheduled tasks, licensing data, or dependencies outside the app folder, and tell the user why. CLI: `--monitor test-install-start/finish/revert-test-install` and `--portableapps list|generate`.
- **Explorer right-click entries.** "Uninstall with Purgeon" and "Who owns this?", fully removed when turned off.
- **Command palette.** `Ctrl+K` for every command and program, with fuzzy search scoring.
- **Tray and notifications.** Optional tray icon for maintenance, updates, startup alerts and interrupted removals.
- **Monthly report.** An HTML summary of a month's changes.
- **Themes and accessibility.** Light and high-contrast themes, keyboard menus, focus outlines, screen-reader labels, skip-to-content link, reduced-motion option, font-size scaling.
- **Explorer context menu manager.** Turn programs' right-click entries off and on without deleting them.
- **Installer detection.** Installers starting while Purgeon runs (also from the tray) are noticed, with an offer to record them.
- **Window and tray options.** Always on Top (also a 📌 thumbtack in Purgeon's own title bar), Minimize to Tray, a close button that asks whether to exit or keep running in the tray (with Remember my choice), Start Minimized to Tray; the tray icon shows the window on a left click and opens its menu on a right click.
- **Start with Windows.** Off by default; a sign-in task, also offered unticked on the installer's last page, and removed on uninstall.
- **Hidden programs.** Hide entries from the list and bring them back.
- **Tooltips everywhere.** Every command, button and field explains what it does and how to undo it.
- **Messages at the bottom.** Notices and errors appear just above the status bar, marked 👍, ⚠️ or ⛔.
- **Analyze.** A one-page report on a program: removal, disk space, hooks, last use, dependencies, signature and architecture. "What It Does" is now "What's This", and "Force Removal" is now "Force".
- **Architecture column.** 64-bit, 32-bit or ARM64, read from each program file's header.
- **Wrapping action bar.** Buttons that don't fit continue on a second row instead of being cut off.
- **New toolbars.** A search box that also runs commands, a details row for the selection, an actions row, and the views as a column of icons on the left. Views renamed to Programs, Apps, Debloat and Cleaner.
- **First-run onboarding.** Welcome dialog on first launch explaining what Purgeon does, with guided starting paths, dismissible tips, and Help › Welcome Back to reopen.
- **Progress feedback.** Progress bars with percentage, items processed and elapsed time on long operations, with pause/resume and cancel where supported.
- **Error recovery.** Error bar with retry action for recoverable errors; undo toast for the last removal within 30 seconds; auto-retry (3 attempts) for transient backend failures; Safe Mode one-click toolbar toggle; batch uninstall pause/resume.
- **Navigation.** Breadcrumb navigation with Back/Forward (Alt+Left/Right), view history, and recent programs sidebar.
- **Documentation.** User Guide dialog with common workflows, What's New on version update, settings explanations in dialogs, settings export/import as JSON.
- **Confirmation management.** Option to disable confirmations with a warning; disable option on each confirmation window; restore disabled confirmation windows in settings.
- **Toggle selection.** Clicking a program in the list selects it; clicking again deselects it.
- **CLI.** `--uninstall` added to help text; `--monitor test-install-start/finish/revert-test-install` for disposable test installs.

## Added in 0.6.0

- **Live install tracking.** The installer and every process it starts, plus Windows Installer's
  `msiexec`, are followed with Event Tracing for Windows. Files and registry changes are recorded as
  they happen, at any depth. This needs administrator rights.
- **Installer records.** Uninstalls use the exact file list from a program's Windows Installer
  package or Inno Setup uninstall log, read before the uninstaller removes it.
- **Silent uninstall.** Windows Installer, Inno Setup, NSIS and WiX uninstallers run without their
  windows when Tools › Silent Uninstall When Possible is on. Unknown uninstallers are never given
  guessed switches.
- **Program backup and transfer.** Programs can be packed into a `.swpkg` file and restored on another
  PC, with profile paths and the user's registry hive moved over. Restores never overwrite existing
  folders and can be undone.
- **Pre-delete re-check.** Right before anything is deleted, Purgeon checks again. It skips
  folders, files and uninstall entries that another installed program still uses, and files that
  Windows counts as shared.
- **Dependency warnings.** Shared runtimes, hardware drivers and programs that others registered a
  need for get a warning before they are uninstalled.
- **Snapshot timeline.** Click two snapshots on the timeline to compare them, or one with now.
- **Command-line install recording.** `--monitor "<installer>"` records an installation without the
  window.

## Added in 0.7.0 (safety)

- **Changed since the scan.** Folders and files that changed after the scan are skipped.
- **Dry run.** Shows exactly what a removal or cleanup would do, and exports the plan.
- **Safe mode.** Offers only near-certain matches, and never services, tasks or firewall rules.
- **Crash-safe removals.** Each item is in the backup before the next is removed. After a crash, the
  removal can be rolled back, finished or left as it is.
- **Fingerprinted backups.** A backup that was changed afterwards is not restored.
- **Backup limits.** Age and size limits that always keep each program's newest backup.
- **Command log.** One line for every command Purgeon runs, kept for 14 days.

## Added in 0.7.0

- **Program insights.** Signature check, programs installed together, possible bundled offers and size growth, with filters.
- **Who owns this?** Which program a file, folder or registry key belongs to.
- **Orphan finder.** Leftovers of programs that are no longer installed, never pre-selected.
- **winget.** Program updates, exporting the program list for a new PC, and reinstalling from the archive.
- **Uninstall Archive.** A permanent record of removed programs and their backups.
- **Always running.** Start-up delays measured by Windows, inbound firewall rules, signatures and updaters in Startup & Services.
- **Scheduled maintenance.** A weekly snapshot, junk clean-up and backup limits.
- **Program migration.** Packages with or without your settings, or settings only.
- **Windows clean-up.** WinSxS, Windows.old, Windows Update clean-up, demo content, older restore points and leftover Store app data.
- **Display.** Larger text and grid lines.

## Watching installations

- Ignore changes made by unrelated processes while monitoring, such as browsers and Windows Update.
- Monitor a program, not just its installer: record what it writes on first run or during an update.
- Notice silent installs that no installer was launched for, and offer to start recording.
- When a monitored program updates, compare it with its recording and add the new files.

## Finding leftovers

- Use what monitored installations created to recognise leftovers of similar programs, such as a
  vendor's usual folder patterns.
- Match leftover executables to a program by their digital-signature publisher.
- Remove a program's drivers and their copies in the driver store, with a backup.
- Find COM registrations whose file no longer exists, within the protected-key rules.
- Find Start Menu and desktop shortcuts that point to deleted programs.
- Find uninstall entries whose uninstaller file is missing.
- Find browser extensions a program installed through Chrome, Edge and Firefox policies.
- Find Explorer right-click entries whose program is gone.
- Read NSIS install logs and InstallShield records where they exist.

## Uninstalling

- Notice when an uninstaller schedules a restart, and continue the leftover scan after it.
- Queue files that are in use for deletion at the next restart, with a backup taken first.
- Remove a Store app's leftover package data and per-user settings.
- Remove Windows' built-in apps, with a strong warning and a way to restore them.
- List installed updates and remove them through Windows' update tool.

## Snapshots

- Scheduled snapshots (daily, or at sign-in), keeping a set number of them.
- Optionally store small configuration files inside snapshots, so changed files can be put back too.
- An editor for the folders and keys snapshots leave out, with presets.
- Notify you when chosen folders or registry keys change.
- Service start types and scheduled tasks as their own snapshot sections.

## Moving and backing up programs

- Back up only a program's settings (AppData and registry), to reinstall cleanly and restore them.
- Move a program to another drive, leaving a link in place, with backup and undo.
- Include a program's services and scheduled tasks in a backup, and recreate them on restore.

## Cleaning

- More junk categories: browser caches (only while the browser is closed), Windows install leftovers,
  rotated logs, and Windows' own component cleanup.
- Find old installer files in Downloads for programs that are already installed.
- **Privacy traces.** Recent-files list, jump lists and the icon cache in the Cleaner, never pre-selected.
- Report large folders in AppData and ProgramData that belong to no installed program.
- Find empty folders in Program Files and AppData, within the protection rules.

## Ease of use

- Program details: publisher site, signature, size breakdown and when the program was last run.
- Sort and filter by when programs were last used, to spot ones to remove.
- Command-line uninstall, leftover scan and junk cleaning for scripts and IT use.
- Driver store clean-up of old driver versions, with a backup.
- Export uninstall, scan and comparison reports as HTML, CSV or JSON.
- Optional notifications of new Purgeon releases, through the GitHub API.
