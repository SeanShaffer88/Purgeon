# Changelog

## Unreleased

### Fixed

- Change Timeline event titles lost their first letters behind the row icon: a style rule for the snapshot strip in the Snapshots view shared its name with the Timeline view, stretched the small placeholder icon in every event row to twice its width, and covered the start of the text. The strip has its own class name now, and a regression test keeps any style rule named after a list view from restyling row icons again.

## 1.0.8 - 2026-10-28

### Fixed

- Disk Usage showed "No drives found" and never scanned anything: the drives script forgot to ask PowerShell for JSON, so its answer could not be read and the failure was silent. The view now reads drives through the system's drive information (with the older way as a fallback) and scans the system drive as soon as it opens.
- The menus are slimmer: related commands now live in flyout groups (for example, the View menu's Zoom, Appearance, Window and Background groups, and the Tools menu's Records, Find & Fix, Lists & Portable and Settings groups) instead of one long list. Nothing was removed — every command is still there, and the command palette still finds them all.
- A removal interrupted while Purgeon was writing its record down (a crash or power cut at exactly the wrong moment) left a damaged record that was silently ignored: the interrupted removal never reappeared and could never be cleared. The damaged record is now reported, explains itself, and can be cleared.
- Two settings changes made at the same moment could silently undo each other; settings writes now take turns.
- A group name typed with hidden control characters could impersonate a built-in group in the filter; leading control characters are stripped from group names.
- Disk Usage listed drives that report no space at all (such as an empty card reader); they are no longer shown.
- The `--help` text now lists the `--sync`, `--portableapps` and `--export` commands, which worked but were undocumented.


### Under the hood

- Removed leftover code and styles from features that no longer exist (about 19 KB of source), which slightly shrinks the built program. Nothing about how Purgeon works has changed.

## 1.0.7 - 2026-10-28

- Removed the What's This page (it was on the Action menu, the action
  bar and Ctrl+W). The same "what it hooks into Windows" list still
  appears inside Analyze Program, which keeps everything in one place.
- Lighter running: the Debloat, Startup & Services, Cleaner and Disk
  Usage screens now load only when first opened, so the window paints
  sooner; and the installer watch checks every 3 seconds while the
  window is in use but backs off to every 10 seconds while Purgeon is
  hidden or in the tray.
- New Disk Usage view (Ctrl+0): what is using the space on each drive,
  biggest first. Open folders to drill down, with each item's share of
  its folder; links are listed but never counted, so nothing is
  double-counted, and a folder whose counting stopped early is marked
  "at least". The scan can be cancelled and keeps what it measured.
  Also on the command line as --disk.
- Safety pass: the long operations that lacked one now have a Cancel —
  removing items with backup, the Windows clean-ups, and the Disk Map
  measuring sweep all stop between steps, report anything not yet done
  as left in place, and keep what was already removed fully undoable.
  Deleting a backup or a snapshot now sends it to the Recycle Bin
  instead of erasing it, so it can be brought back. Also fixed: after
  running Windows clean-ups, the report could fail to appear; it now
  shows every time.
- Built-in groups for the program lists, computed live and shown above
  your own groups in the group picker: Bundled software (possible
  offers), Installed together, Unsigned, Bad signature, Growing in
  size, Large programs (1 GB or more), Recently installed (30 days),
  Microsoft, and No publisher listed. A program can be in several
  built-in groups at once and still keep its own group.
- The Apps view now lists everything that is installed, like a full
  inventory: framework and system components appear with a "system
  component" tag and are shown locked — never offered for removal —
  and the header counts them. Known pre-installed apps carry a short
  plain-words note about what they are. Apps with a provisioned copy
  (the copy Windows gives to new user accounts) are tagged, and
  removing one offers to remove the provisioned copy too, in both
  single and batch removal. Removed Store apps can be brought back
  from the Uninstall Archive: Purgeon re-registers a copy still on
  the PC, or opens the app's Microsoft Store page when none remains.

## 1.0.6 - 2026-10-28

- Debloat grows from 26 to 93 tweaks. A new App Privacy section carries
  the same per-app permission switches as Settings › Privacy (account
  info, location, camera, microphone, contacts, calendar, email,
  messages, files, passkeys, Bluetooth, eye tracking, screenshots and
  more), plus new privacy, suggestions, search, Explorer and
  settings-sync toggles — every one reversible the usual way, with the
  previous value restored when switched off.
- Installing or uninstalling now closes a running Purgeon first: the
  installer asks the open program to exit cleanly (with a forced close
  as a fallback if it does not answer), and a silent install relaunches
  it when finished, so upgrades never fail on locked files and never
  need a manual close.
- New premium look: a near-black design with red accents and white text.
  A gradient header band names the open view with its headline number,
  the program list sits in a recessed panel with rounded corners, view
  icons rest in a floating rail, primary actions (Uninstall, dialog
  confirmations) are red gradient buttons, selection washes red, and the
  status bar carries the PC specs in a pill. The light and high-contrast
  themes keep working as before.
- New System Info window (action bar, Tools menu, or `--sysinfo` on the
  command line): Windows edition, version and uptime; processor with
  core, thread and clock details; memory size, type, speed and slots;
  motherboard; graphics with memory and resolution; every drive with
  its size, connection and type; optical drives; and audio devices.
  Temperatures for the processor and drives are shown where Windows
  reports them.


## 1.0.5 - 2026-10-27

- Fixed the action bar breaking after switching views: it measured its
  width once, from the first view's bar, and after a view change the stale
  reading left every action squeezed into a single row with cut-off
  labels. It now measures the bar that is actually on screen, on every
  view change.
- Program name tags (insights such as "unsigned" and "possible offer",
  hidden and group tags) now sit at the far end of the name field instead
  of crowding next to the program's name, and long names shorten with an
  ellipsis instead of pushing the tags around.
- The status bar now shows basic PC specs on its right side — Windows
  edition, processor and memory — gathered once when Purgeon starts.
  Hovering shows the full details, including the Windows build number.
- Removed the Cleaner's "Large orphaned folders" category. It guessed by
  folder name and flagged folders that belong to programs still
  installed; the Cleaner now offers only categories that are safe to
  clean. The cleanup scan also no longer loads the full program list.

## 1.0.4 - 2026-10-27

### Changed
- Purgeon is now 64-bit only. Releases ship exactly two files: Purgeon-Setup-x64.exe (the native x64 installer) and Purgeon-Portable-x64.zip (the portable build). The 32-bit build, the universal installer and the MSI are discontinued; 64-bit Windows 10 or 11 is required. The installers remain unsigned.
- Repeat program-list loads are much lighter: signature and processor-architecture results, and extracted program icons, are remembered per program file and only recomputed when that file changes, so refreshing the list no longer re-runs the full signature sweep.
- Background measuring and insight work now starts after the window has painted, and measured program sizes are applied to the list in small batches, making the first seconds after launch smoother.
- Settings are no longer re-read from disk on every operation; the saved settings are kept in step with the settings file's modified time, so outside edits are still picked up.
- The command log is now flushed before the app exits, and the window shows a brief loading note instead of a blank page while Purgeon starts.

## 1.0.3 - 2026-10-27

### Fixed
- The first-run tips could never be closed: the tip box kept its own dismissed list that nothing updated, while the rest of the app kept a second list the tip never read — and the dismiss-all update packed the tip ids into the set as one nested list, so Dismiss, the X button and Escape all dismissed nothing and the box stayed over the window. The tips also appeared at the same time as the Welcome dialog instead of after it. The tips are now controlled by the app's dismissed set, appear one at a time after the Welcome dialog finishes, and close properly by button, X and Escape.
- Stacked dialogs no longer all answer Escape at once: only the topmost layer closes, one at a time (the command palette counts as a layer, and consumes its own Escape). Dialogs also keep keyboard focus where it belongs instead of taking it back on every redraw.
- The first tip's "Try it now" button pointed at a window that does not exist and opened nothing; it now opens the command palette. The tip's text also showed the literal characters of a key tag instead of the styled key.

## 1.0.2 - 2026-10-27

### Fixed
- The window no longer opens empty and black on machines where a dialog is the first thing drawn: the shared dialog component used a standard building block it never imported, and the first dialog (such as the first-run Welcome box) emptied the whole window. The build could not see this mistake, so a permanent test now fails the suite if any window file ever uses one of those building blocks without importing it.
- If drawing the window ever fails again, a readable error screen appears instead of an empty window, and the window can always be closed: the program no longer intercepts the close button until the page has loaded and confirmed it is ready.
- Starting the program no longer creates a Windows restore point when there is nothing to prune; a restore point is now made only when an old backup is really about to be removed under the backup limits.

## 1.0.1 - 2026-10-27

- Restore the main window to the layout in the README screenshot: menu bar,
  command bar, selection bar, action bar, program list and status bar only.
  The breadcrumb bar, the recent-programs rail, the Safe Mode button in the
  command bar and the quick-filter chips no longer sit on the window; every
  feature remains available — Back/Forward, the quick list filters and the
  recent programs moved to the View menu, and Safe Mode stays in the Tools
  menu. The Uninstall button is plain dark like the other action buttons,
  and the action bar now lays its buttons out in balanced rows of equal
  width (13 actions lay out 7 + 6, never 10 + 3) at any window width.
- Fix a build-breaking typo in the About dialog (`width=560` for
  `width={560}`) that stopped the front end from building at all.

- Repair the native build gate: format the Rust sources, share UTF-16 registry
  decoding, name snapshot entry types, and run development/test binaries without
  requesting elevation. Production manifests retain their existing privileges.
- Correct stale npm package metadata to Purgeon; preserve legacy data and upgrade
  identities so existing settings and backups remain accessible.
- Build x86 and x64 applications. Package one architecture-selecting Setup EXE,
  one x86 MSI compatible with both Windows architectures, and one portable ZIP
  containing both builds, LICENSE and portable instructions. Add installer and
  downloaded-artifact checks to CI.
- Keep the x86 application's Windows helpers, registry reads and Program Files
  roots in the native OS view, so its MSI installation can inspect 64-bit programs
  on 64-bit Windows. Preserve explicit user-supplied executable paths.
- Validate the entire command line before initializing the backend or running an
  operation. Reject unknown or repeated options, conflicting commands, unexpected
  arguments, and missing values instead of ignoring them.
- Route command-line typos to an error and exit code 1 instead of opening the main
  window. Keep tray, sign-in, queue-resume, and Explorer launches available.
- Show help without initializing the application's backend stores and command log.
  The native application and WebView2 still start and may create their runtime data.

- Restore command-line validation on the startup path the app actually uses,
  including the restored `--list-snapshots` command: invalid requests are
  rejected before the backend initializes instead of reaching it.
- Treat the Windows folder on any drive as protected, instead of relying only
  on the SystemRoot environment variable.
- Add the missing tooltips for the User Guide, Keyboard Shortcuts and Welcome
  commands.
- Regenerate the Rust lock file, which still recorded the app at 0.7.0 and
  blocked every locked build.
- Run the release pipeline's tests on windows-latest and windows-2022, and
  build the release files with the packaging script, which assembles and
  verifies the universal installer, the MSI and the portable ZIP.

Earlier feature history is in [the roadmap](docs/ROADMAP.md).
