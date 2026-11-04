# Project audit — 2026-11-03

This ledger records a bounded source review and local checks. Test locations do
not establish whole-feature runtime coverage. The latest v1.4.3 local gates passed:
565 JavaScript tests, 143 native tests (141 unit plus two manifest, two ignored),
lint, typecheck, production build, formatting and strict locked all-target x64
MSVC Clippy. Every process and runner exited 0. See the cleanup-admission addendum
for independent review. Current-tree GitHub CI and artifact verification remain
pending at preparation time. This is not release qualification.

## JavaScript repairs

- Cookie policies use explicit Registry provider paths and terminating errors.
  Absent keys are empty; read faults propagate. Add/remove verifies the requested
  result across Chrome and Edge before success/history. Failures can leave a
  partial result and say so; there is no inferred rollback. The displayed union
  preserves unrelated pre-existing browser differences.
- Power timeout validation checks both values before either command. Zero remains
  never; null remains invalid. A failed second command rejects without guessed undo.
- JSON-shaped settings are copied at default/read/cache/input/output boundaries,
  preserving serialized writes, fresh reads, damaged-data preservation and migration.
- Command diagnostics retain operation identity, approved system-tool identity,
  duration and outcome. Arbitrary executable names, paths, arguments, script bodies,
  exception text and nonnumeric exit payloads are omitted. Caller results/errors
  remain unchanged.
- API serialization defaults to guarding every handler. The explicit concurrent
  allowlist contains reviewed queries, transient query caches, cancellation and
  window controls. Persistent state changes (including monitor polling, startup
  baseline creation and outside-uninstall archiving) remain guarded. Unknown
  handlers still error; newly added handlers acquire the guard automatically.
- Performance measurements use installed Node/Vite directly, with no shell or
  auto-download. Failed launches, signals and nonzero children reject the run.
  Summary parsing accepts anchored TAP and spec pass/fail counts, including CRLF
  and zero counts; missing or malformed summaries reject reporting.

## Native, UI and second-round repairs

- Native writes/appends pin ancestors and validate exclusive handles before
  mutation; erasure uses opened-handle length and checks final cancellation.
  Boot changes recheck grant expiry and parent liveness at mutation boundaries,
  preserving refusal evidence. Scratch-file regressions are in
  [file mutation tests](../src-tauri/src/file_mutation_tests.rs); Boot tests live
  in [boot_native.rs](../src-tauri/src/boot_native.rs). Live BCD changes were not run.
- UI repairs separate Disk Usage (`Ctrl+Shift+0`) from
  reset zoom (`Ctrl+0`), invalidate stale disk work on unmount, and add bounded
  accessible names/state/relationships. Evidence:
  [UI checks](../test/audit-ui.test.js) and
  [render checks](../test/audit-ui-render.test.js). These tests do not certify
  WebView interaction or screen-reader behavior. Avoided stale-work counts do
  not measure CPU or idle performance.
- Second-round archive, duplicate-removal, monitoring-cancellation, API dispatch,
  partial-change diagnostics and CLI classification repairs passed final local
  verification. Regression locations:
  [archive](../test/audit-archive-integrity.test.js),
  [duplicates](../test/audit-duplicate-removal.test.js),
  [monitor cancellation](../test/audit-monitor-cancel.test.js),
  [partial diagnostics](../test/audit-partial-diagnostics.test.js), and
  [API guard](../test/audit-api-guard.test.js). Duplicate metadata/hash checks
  cannot guarantee atomicity against external filesystem writers.
- Cookie explanations describe the combined Chrome/Edge list, intentional
  preservation of unrelated policy differences and Firefox's exclusion.
  Monitoring/disposable documentation now states capture and recovery limits.
  This explanation-only UI edit changes no layout or controls.

Regressions: [boundaries](../test/audit-js-boundaries.test.js),
[API guard](../test/audit-api-guard.test.js),
[performance child outcomes](../test/perf-result.test.js).

## Feature inventory

Every row has source inventory only; linked suites add bounded unit/mock evidence.
Live integration remains unverified unless separately recorded by the controller.

| Feature family | Backend source | Existing evidence / runtime gap |
| --- | --- | --- |
| Program inventory, insights, groups | [programs](../src/backend/programs.js) | [insights cache](../test/insights-cache.test.js); real inventory gap |
| Uninstall, force, leftovers, ownership | [installers](../src/backend/installers.js) | [safety](../test/safety.test.js); real deletion not run |
| Batch and restart queue | [queue](../src/backend/queue.js) | [state reads](../test/state-read-failures.test.js); reboot gap |
| Installation monitoring | [monitor](../src/backend/monitor.js) | [notes](../test/monitor-notes.test.js); live ETW gap |
| Installer detection | [installwatch](../src/backend/installwatch.js) | [monitoring defaults](../test/monitoring-defaults.test.js); real process detection gap |
| Trials and recovery | [trials](../src/backend/trials.js) | [recovery](../test/recovery.test.js); live restore gap |
| Snapshots and comparison | [snapshots](../src/backend/snapshots.js) | [state reads](../test/state-read-failures.test.js); live full capture gap |
| History, timeline, archive | [history](../src/backend/history.js) | [history integrity](../test/history-integrity.test.js); full workflow gap |
| Analysis, impact, dependency graph | [impact](../src/backend/impact.js) | [graph](../test/graph.test.js); real dependency interpretation gap |
| Disk usage and duplicates | [diskusage](../src/backend/diskusage.js) | [duplicates](../test/duplicates.test.js); live large-volume gap |
| Migration and settings sync | [transfer](../src/backend/transfer.js) | [transfer identity](../test/transfer-identity.test.js); live migration gap |
| Winget and self-update | [updatecheck](../src/backend/updatecheck.js) | [update native](../test/update-native.test.js); actual installer not run |
| Generic portable discovery/registration | [portable](../src/backend/portable.js) | [safety](../test/safety.test.js); configured folders retained |
| Disposable capture/recovery | [monitor](../src/backend/monitor.js) | [portable disposable](../test/portable-disposable.test.js); actual installation gap |
| Heuristic portable assessment | [classification](../src/backend/portable-classification.js) | [classifier](../test/portable-classification.test.js); not proof of runtime portability |
| PortableApps.com/PAF generation | Removed | UI/API/CLI removed; existing package data preserved |
| Junk and privacy cleanup | [junk](../src/backend/junk.js) | [safety cancellation](../test/safetycancel.test.js); real cleanup not run |
| Browsers and cookie policies | [cookierules](../src/backend/cookierules.js) | [audit boundaries](../test/audit-js-boundaries.test.js); host policies untouched |
| Startup, services and tasks | [startup](../src/backend/startup.js) | [task native](../test/tasks-native.test.js); live Scheduler/UAC gap |
| Processes and resource alerts | [processes](../src/backend/processes.js) | [processes](../test/processes.test.js); live control gap |
| Boot, drivers and restore tools | [boot](../src/backend/boot.js) | [drivers](../test/drivers.test.js); BCD/driver/reboot not run |
| Power, DNS and TCP settings | [power](../src/backend/power.js) | [DNS](../test/dns.test.js), audit boundaries; live changes not run |
| Event logs and system information | [eventlogs](../src/backend/eventlogs.js) | [event logs](../test/eventlogs.test.js); live clear/export gap |
| Explorer integration and Debloat | [debloat](../src/backend/debloat.js) | [native catalog](../test/debloat-catalog-native.test.js); host mutations not run |
| Scheduled maintenance, tray, reports | [schedule](../src/backend/schedule.js) | [resource views](../test/resource-views.test.js); live scheduling gap |
| Settings, policy, trust, plugins | [settings](../src/backend/settings.js) | [settings cache](../test/settings-cache.test.js), audit boundaries; plugin runtime gap |
| Navigation, themes, accessibility | [application API](../src/backend/api.js) | [resource dialogs](../test/resource-dialogs.test.js); full accessibility/scaling gap |
| CLI and native launch routing | [CLI parser](../src/cli-args.js) | [CLI](../test/cli.test.js); packaged routing gap |
| Packaging and diagnostics | [command log](../src/backend/log.js) | [self health](../test/selfhealth.test.js); installer lifecycle gap |

## Validation evidence and limits

The controller's final combined run passed 562 JavaScript tests (zero failures,
zero skipped), 141 native unit and two manifest tests (143 passed, two ignored).
`npm test`, `npm run lint`, `npm run typecheck`, `npm run build`,
`cargo fmt --all --check`, strict locked all-target x64 MSVC Clippy and locked
all-target x64 tests all had process and DevTools runner exits 0, recorded in
`analysis-logs/full-audit-checks.json` and its logs outside the repository.
The earlier dependency repair with `npm ci` also exited 0.

Final independent review `20261104T000933Z-5e11f3164e15` accepted the bounded
PortableApps.com/PAF generation removal with no blockers: 58 focused tests and
extraction checks exited 0. Its broader sandbox run passed 102/103 tests; only
CLI scratch-directory creation failed with `mkdtemp` EPERM. The controller's
full 562-test pass resolves that host check. Earlier native/UI and backend
independent acceptance remains limited to its reviewed scope.

Earlier worker runs failed before child launch when the DevTools external log
directory was inaccessible (shell exit 1, no helper result), and an offline
clean install failed with cache EPERM (exit -4048). Missing dependencies and
sandbox-denied native file tests also caused failures. The controller's repaired
install and final combined run resolve these local check failures. Initial
focused regressions exposed defects; repaired subsets passed. Earlier performance
attempts rejected a failing test child or failed on missing Vite; neither was a
successful test-wall baseline.

The performance-summary repair passed three focused tests on Node 26.13.0
(exit 0), covering TAP/spec, CRLF, zero counts, invalid summaries and failed
children; its TAP run also passed. No Node 22 execution is claimed.
The fixed `npm run perf` then passed with process and runner exits 0 in DevTools
run `20261104T000950700Z-c02deb26c9574d34b9438e05583b5c70`: build 509 ms,
1,156,286 asset bytes across 53 files, tests 34,307 ms wall with 562 passed and
zero failed on Node 26.13.0. The actual pre-removal audited dirty source build
contained 1,174,736 bytes across 53 files: a reduction of 18,450 bytes (1.57%).
Bundle bytes and test elapsed time establish no application CPU/idle or speed
improvement; performance budgets remain unestablished.

Offline npm inventory found 159 components but returned unknown advisory/license
coverage (helper exit 3, valid false, advisory evidence missing). The Cargo helper
could not parse the lockfile's `#` header (exit 125). Unrestricted offline Cargo
metadata initially failed on uncached `mac-notification-sys`; the Windows-scoped
`cargo metadata --locked --offline --filter-platform x86_64-pc-windows-msvc`
succeeded (exit 0), inventorying 290 packages in
`analysis-logs/full-audit-cargo-inventory.json` outside the repository. Inventory
does not establish advisory/license clearance. No online audit, dependency update
or implicit restore was performed by this worker. Sixty source heuristic privacy
candidates were independently classified as false positives; that bounded review
does not establish that the project is free of secrets or telemetry risks.

Coverage floors (85% core, 70% overall and every destructive path) remain unproven.
Production WebView/native capture is incomplete; the historical LLVM JSON/LCOV
denominator discrepancy remains unresolved. LLVM tool lookup on PATH is Unknown,
not proof that instrumentation is unsupported. Live ETW, Windows versions, UAC,
privileged cancellation, packaged UI/CLI, accessibility and installer lifecycle
need separate evidence. No host cleanup, VM, tag, release, commit, push or merge
was performed by this worker. Final local gates passed; GitHub CI, artifact
verification and merge remain pending. No release qualification is claimed.

## v1.4.3 cleanup-admission addendum — 2026-11-03

PR #89's audit fixes and PortableApps.com/PAF removal passed GitHub CI and were
merged, as verified by the release controller. Earlier pending CI/merge statements
describe the pre-merge snapshot. New cleanup-admission local checks passed as
recorded below; current-tree GitHub CI and v1.4.3 artifact verification remain
pending at preparation time and are not covered by that earlier evidence.

At clean HEAD `6bea8b2`, an in-memory reproduction exited 0: an interrupted
removal reported `reviewRequired === true`; calling
`removeItems({ title: 'Later empty cleanup', items: [] })` returned
`{ backupId: null, results: [], cancelled: false }`, after which `interrupted()`
returned `null`. The adapter observed `pending.json` overwritten and deleted.
The old manifest remained, but its recovery reference disappeared. No disk,
registry, Recycle Bin or native mutations occurred in this reproduction.

The approved repair is limited to admission in
[removeItems](../src/backend/backups.js): read pending recovery before settings,
directory creation or writes. Proceed only when no pending record exists. Reuse
the existing diagnostic for corrupt or unreadable records; reject every valid
pending record until explicit recovery review or resolution, regardless of an
empty, sealed, missing, encrypted or uncertain referenced manifest. Preserve
recovery resolution, preview, cancellation, encryption and API interfaces.
This covers sequential calls under the existing API mutation guard, not
cross-process exclusion.

Required regressions in [backup checkpoint tests](../test/backup-checkpoint.test.js)
cover a fixture checkpoint failure followed by another cleanup, including an
empty request; byte-identical retained evidence and no additional writes,
directory creation, deletion or mutation commands; malformed JSON, read denial
and a missing manifest; and successful cleanup after explicit resolution.
Normal success and cancellation regressions remain. Independent review
`20261104T004218Z-32efd002e461` accepted the repair, and all 13 focused tests
passed with zero failures. All seven full current-tree local gates succeeded in
`../analysis-logs/next-reliability-checks.json` (relative to the repository root):
565 JavaScript tests; 143 native tests (141 unit plus two manifest, two ignored);
lint; typecheck; production build; formatting; and strict locked all-target x64
MSVC Clippy. Every process and DevTools runner exited 0.

Static findings about rollback clearing pending before its final seal and restore
batch cancellation ordering are outside this repair. Neither is claimed fixed.
Mock/scratch checks do not qualify live recovery, UAC, ETW, installer lifecycle,
OS-matrix behavior or screen readers. Coverage floors remain unproven, generic
IPC remains, and no whole-product security certification is claimed.
