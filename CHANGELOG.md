# Changelog

## Unreleased

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
