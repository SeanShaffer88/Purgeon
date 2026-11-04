# Purgeon 1.4.3

## Cleanup and Recovery

- Cleanup stops when a recovery checkpoint cannot be saved. It retains the pending backup and uncertain operation instead of deleting another item or sealing an unconfirmed backup, including native task checkpoints.
- New cleanup is refused while any pending removal requires review or resolution, including an empty request. Corrupt or unreadable pending records also block admission before settings reads or writes.
- Program-restore undo records per-item intent and completion, validates imported state and original evidence, stops on conflicts, and resumes only unfinished proven phases. Native journal leases and atomic restore ID reservation protect existing journals. Imported files stay in same-volume recovery staging. Legacy records without expected state require manual review; external registry writers and directory-child races remain limits.
- Settings replacement undo validates an exact native Recycle Bin receipt, including original identity and bounded content evidence. It refuses missing, changed or ambiguous evidence and restores through the held original handle without overwriting another occupant. Live Recycle Bin recovery remains unverified.
- Transfer registry undo pins validated original exports and native-owned Unicode import images before mutation, retaining file and ancestor pins through the native importer's confirmed exit. Uncertain termination keeps recovery locked until reaped. Scratch files and neutral child processes provide regression evidence; live registry imports were not tested.

## Maintenance Fixes

- Native writes and appends pin handles and ancestors; secure erase uses the opened file's length and checks final cancellation. Boot changes recheck authorization at mutation boundaries and retain refusal evidence.
- Both power timeout values are validated before changes. Nested settings values are isolated across callers and queued writes.
- Diagnostics redact command payloads. Unclassified application operations are guarded against overlapping mutations while reviewed queries and cancellation remain available.
- Cookie policies use explicit registry provider paths, propagate read failures and verify Chrome and Edge results. Partial failures require refreshing the combined list before retrying.
- Archive integrity, duplicate removal, monitor cancellation and partial-change diagnostics receive bounded regression fixes. External filesystem writers remain a limit on duplicate removal checks.
- Disk Usage uses `Ctrl+Shift+0`, separate from reset zoom (`Ctrl+0`), discards stale work and exposes control names and selection state. Performance checks use installed Node/Vite, reject failed child commands and validate test summaries.

## PortableApps.com Packaging Removed

PortableApps.com/PAF generation and its UI, API and CLI entry points are removed. Generic portable discovery and registration, Purgeon's portable ZIP, disposable capture/recovery and heuristic assessment remain. Existing user packages are untouched.

## Validation and Downloads

Local checks pass: 565 JavaScript tests and 143 native tests (141 unit and two manifest tests, with two ignored), lint, typecheck, production build, formatting and strict locked all-target x64 MSVC Clippy. Independent review accepted the cleanup-admission repair; all 13 focused tests passed. The release pipeline verifies package builds, contents and hashes.

Validation uses mock system adapters and neutral scratch fixtures. Live UAC, ETW, privileged mutation, installer lifecycle, recovery, Windows OS-matrix and screen-reader behavior remain unqualified. The 85% core and 70% overall coverage floors remain unproven. Generic IPC remains in other operation families; no whole-product security certification is claimed.

Windows x64 only. Packages are unsigned when signing credentials are not configured. Download **Purgeon-Setup-x64.exe** or **Purgeon-Portable-x64.zip**. The ZIP contains **Purgeon-Portable-x64.exe**, **LICENSE** and **PORTABLE.txt**. There is no x86 or MSI build.
