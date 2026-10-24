# Roadmap

Planned enhancements, grouped by area. Each is meant to be built the same way as the rest of
SweepUninstall: original code, every change backed up and undoable, and nothing offered that
Windows or another installed program still needs.

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
- **Pre-delete re-check.** Right before anything is deleted, SweepUninstall checks again. It skips
  folders, files and uninstall entries that another installed program still uses, and files that
  Windows counts as shared.
- **Dependency warnings.** Shared runtimes, hardware drivers and programs that others registered a
  need for get a warning before they are uninstalled.
- **Snapshot timeline.** Click two snapshots on the timeline to compare them, or one with now.
- **Command-line install recording.** `--monitor "<installer>"` records an installation without the
  window.

## Added after 0.6.0

- **Changed since the scan.** Folders and files that changed after the scan are skipped.
- **Dry run.** Shows exactly what a removal or cleanup would do, and exports the plan.
- **Safe mode.** Offers only near-certain matches, and never services, tasks or firewall rules.
- **Crash-safe removals.** Each item is in the backup before the next is removed. After a crash, the
  removal can be rolled back, finished or left as it is.
- **Fingerprinted backups.** A backup that was changed afterwards is not restored.
- **Backup limits.** Age and size limits that always keep each program's newest backup.
- **Command log.** One line for every command SweepUninstall runs, kept for 14 days.

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
- Report large folders in AppData and ProgramData that belong to no installed program.
- Find empty folders in Program Files and AppData, within the protection rules.

## Ease of use

- "Uninstall with SweepUninstall" in Explorer's right-click menu for shortcuts and programs.
- Program details: publisher site, signature, size breakdown and when the program was last run.
- Sort and filter by when programs were last used, to spot ones to remove.
- Command-line uninstall, leftover scan and junk cleaning for scripts and IT use.
- Export uninstall, scan and comparison reports as HTML, CSV or JSON.
- Optional notifications of new SweepUninstall releases, through the GitHub API.
