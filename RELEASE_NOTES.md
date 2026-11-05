# Purgeon 1.6.0

Unsigned Windows x64 stable release with the qualification limits below.

- Remove AV keeps its launch checkpoint protected from another Purgeon instance until the originating operation has finished launch, cleanup and status finalization. An active checkpoint cannot be acknowledged or deleted by another instance.
- After the owner finishes or exits, a valid checkpoint still requires explicit review acknowledgment. Partial or invalid checkpoint contents remain blocked for manual review; there is no automatic retry or deletion. Retained vendor payloads are preserved.
- Includes the refresh-admission fix from PR98: new plans cannot use cached eligibility while inventory refresh is running.
- App and reusable `purgeon-core` metadata and consumption examples target `1.6.0`.
- VaporGrid styling adds charcoal compartments, crimson selection edges, a subtle workspace grid and visible focus. The left navigation always uses icons with accessible names and shortcut tooltips. Programs and Remove AV retain their existing actions and review safeguards; light and high-contrast themes remain available.

## Qualification limits

This release is unsigned. Windows may display publisher/trust warnings. Live vendor removal, UAC, Safe Mode and vendor utilities outliving Purgeon remain **UNVERIFIED**. Existing Windows CI and disposable installer lifecycle checks validate their own contracts; they do not qualify vendor removal. Launch status does not mean removal completed and provides no undo. No silent/forced-removal, boot-mode or reboot changes are introduced.

Dependency audits: full `npm audit` exited 1 with four moderate ESLint/minimatch development findings; production `npm audit --omit=dev` exited 0 with zero advisories. `cargo audit` exited 0 with zero vulnerabilities and informational unmaintained, unsound and yanked-package warnings. These results do not establish that all security concerns are cleared.

## Assets and rollback

The Windows release contains exactly `Purgeon-Setup-x64.exe` and `Purgeon-Portable-x64.zip`. The ZIP contains `Purgeon-Portable-x64.exe`, LICENSE and PORTABLE.txt. The core tarball is a separate development artifact; no npm registry publication is configured.

To roll back, close Purgeon and any vendor utility, retain a copy of existing data, backups, checkpoints and retained reviews, then use a previously verified distribution. Do not delete or reset data to downgrade. Review unresolved vendor attempts before further changes. Downgrading does not undo vendor removal; interpretation of newer records and rollback with 1.6.0-created data have not been qualified.

---

The following beta notes are historical and retain their original scope.

# Purgeon 1.5.0-beta.1

Windows x64 beta with the qualification limits described below.

- The dependency-free `purgeon-core` package provides canonical reusable feature APIs with explicit host registration and approval contracts. Native integration and application lifecycle remain app-owned.
- Reliability work includes recovery and process containment, reviewed manual coverage ratchets, and separate installed/portable NSIS payload verification.
- Remove AV inventories registered security products and offers confirmed official consumer vendor utilities for supported AVG, Avast, Norton and McAfee products. Defender has no removal action; ESET is instructions only. Unsupported products remain visible. Launch status does not mean removal completed and provides no undo.

## Qualification limits

This beta is unsigned. Windows may display publisher/trust warnings. Live vendor utility execution, UAC, Safe Mode and utilities outliving Purgeon are **UNVERIFIED**. Disposable CI installer lifecycle checks validate their own installer contracts; they do not qualify AV removal. Mock/static tests do not establish privileged recovery, production WebView coverage, full accessibility or broad Windows compatibility.

A known Remove AV race remains: while an inventory helper is running, a concurrent request can prepare a plan using eligibility from the prior inventory. Refresh completion/failure invalidation does not cover refresh admission. The next slice will address this race; this release preparation does not fix it. Avoid concurrent refresh and plan preparation.

PR91–96 are merged with successful final-head Windows test/build checks; their publish jobs were skipped. Historical alpha, canceled-beta and coverage records retain their original scope. Prior coverage evidence may be reused only after exact proof that all 296 measured files are unchanged; no new coverage pass is claimed here. The historical blanket 85% core / 70% overall failures remain recorded under the adopted manual policy.

Dependency audits: full `npm audit` exited 1 with four moderate ESLint/minimatch development findings; production `npm audit --omit=dev` exited 0 with zero advisories. `cargo audit` exited 0 with zero vulnerabilities and informational warnings. These results do not establish that all security concerns are cleared.

## Assets and rollback

The release workflow must produce exactly `Purgeon-Setup-x64.exe` and `Purgeon-Portable-x64.zip`. The ZIP contains `Purgeon-Portable-x64.exe`, LICENSE and PORTABLE.txt. The reusable package tarball is a separate development artifact; no npm registry publication is configured.

To roll back, close Purgeon and any vendor utility, retain a copy of Purgeon's existing data, backups, checkpoints and retained reviews, then use the verified 1.4.3 distribution. Do not delete or reset data to downgrade. Review unresolved recovery/vendor attempts before further changes; 1.4.3 does not undo vendor removal or guarantee interpretation of beta-only records. Keep the retained copy for recovery with the beta if needed. Rollback behavior with beta-created data has not been executed or qualified.
