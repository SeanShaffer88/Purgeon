# Changelog

## Unreleased

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
