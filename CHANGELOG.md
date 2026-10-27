# Changelog

## Unreleased

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

Earlier feature history is in [the roadmap](docs/ROADMAP.md).
