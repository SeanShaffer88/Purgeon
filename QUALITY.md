# Quality and release gate

## 2026-11-03: ten reliability priorities, validation in progress

See [Reliability validation](docs/RELIABILITY_VALIDATION.md) for scoped evidence.
The original CI run had seven native failures. The two-file CI short-path
correction passed local root checks: 168 native tests (166 unit plus two manifest,
two ignored), formatting and strict locked all-target x64 Clippy, all exit 0
(`../analysis-logs/ten-ci-corrected-native-checks.json`). New CI is pending.
The unchanged JavaScript suite passed 594 tests; lint, typecheck and frontend
build passed. Previous-snapshot candidate build, safe CLI suite and package
regressions exited 0 before the two-file correction; they do not validate it.
Earlier candidate CLI 9/9 and static package checks passed before that rebuild.

Previous-snapshot combined coverage accounting exits 1 (`below-floor`), with no incomplete
reasons and all 32 Rust files mapped. Diagnostic overall/core results are 35.26% /
65.16% JavaScript and 34.81% / 34.84% Rust. No production WebView workload was
collected. The required 70% overall / 85% core floors remain blockers; do not
merge, tag or claim release readiness. Disposable installer CI and privileged
runtime qualification remain pending. Earlier entries retain their historical scope.

## 2026-11-03: v1.4.3 scoped maintenance preparation

PR #89 passed GitHub CI and was merged. Its scoped audit and PortableApps.com/PAF
removal evidence remains recorded below; historical pending CI/merge statements
describe the earlier snapshot and are superseded for PR #89.

Preparation includes cleanup checkpoint retention, exact replacement identity,
resumable program-restore undo, pinned transfer registry undo and merged audit
fixes. A newly reproduced cleanup-admission defect can discard an unresolved
pending recovery reference even for an empty cleanup. Its bounded admission guard
passed independent review `20261104T004218Z-32efd002e461` and all 13 focused
tests (zero failures). See the
[audit addendum](docs/PROJECT_AUDIT.md#v143-cleanup-admission-addendum--2026-11-03).

This is scoped maintenance, not full runtime qualification. Mock/scratch evidence
does not qualify live UAC, ETW, privileged recovery, installer lifecycle, the OS
matrix or screen readers. Coverage floors and the native denominator discrepancy
remain unresolved. Generic IPC remains; no security certification is claimed.
Packages are unsigned when signing credentials are not configured. Actual artifact
contents, signatures and downloaded hashes still need verification.

All seven current-tree local gates in `../analysis-logs/next-reliability-checks.json`
succeeded: 565 JavaScript tests; 143 native tests (141 unit plus two manifest,
two ignored); lint; typecheck; production build; formatting; and strict locked
all-target x64 MSVC Clippy. Every process and DevTools runner exited 0.
GitHub CI and release artifact verification remain pending at preparation time.

## 2026-11-03: project audit, final local gates passed

Final local gates passed: 562 JavaScript tests (zero failures or skips), 141
native unit plus two manifest tests (143 passed, two ignored), lint, typecheck,
production build, formatting and strict locked all-target x64 MSVC Clippy.
Every process and DevTools runner exited 0; the earlier `npm ci` repair exited 0.
Final independent review `20261104T000933Z-5e11f3164e15` accepted the bounded
PortableApps.com/PAF generation removal with no blockers. Generic portable
support remains. Earlier native/UI and backend acceptance retains its scoped limits.

The [project audit ledger](docs/PROJECT_AUDIT.md) records the checks and remaining
gaps. Fixed `npm run perf` exited 0 (process and runner) on Node 26.13.0:
509 ms build, 1,156,286 asset bytes across 53 files, and 34,307 ms test wall time
with 562 passed and zero failed. Against the actual pre-removal audited dirty
source build (1,174,736 bytes, 53 files), assets decreased 18,450 bytes (1.57%).
These measurements establish no application CPU/idle or speed improvement.

Production WebView/native coverage, the LLVM denominator discrepancy and the
85% core / 70% overall coverage floors remain unresolved. Privileged runtime,
installer lifecycle and accessibility qualification remain incomplete. GitHub CI,
artifact verification and merge are pending; local gates do not qualify a release.
Historical records below retain their original scope and dates.

## 2026-10-29: resource and latest UI/defaults validation

All 25 approved resource source changes passed independent review. The latest
Services-tab and Groups-row navigation-toggle revision passed the full safe
JavaScript suite (326/326, zero skipped), ESLint, TypeScript and production build
(all exit 0). Native formatting, strict x64 Clippy and tests passed earlier on the
unchanged native source: 55 unit and 2 manifest tests; two read-only probes were
ignored by default. The Event Logs read-only probe separately passed with 1,186
rows, 361 readable metadata results and 825 unknown results. No mutation was run.

Installer detection, startup monitoring, resource alerts and automatic size
history default off. Saved explicit opt-ins and manual inspection remain. Startup
and Services are separate views; the navigation-label toggle sits beside Groups.

Native coverage collection then actually exited 0 using the installed versioned
Rust 1.99.0/LLVM 23.1.1 toolchain, a fresh separate target directory, serial builds,
and only default safe tests (55 unit + 2 manifest passed, two probes ignored).
JSON and LCOV exports both exited 0 and include all 19 native source/build files;
native source hashes stayed unchanged. Eight actual export objects, the merged
profile and raw exports are hashed in native-coverage-provenance.json under the
recorded resource-implementation evidence directory. Accounting exited 1:
atomic_file.rs reports JSON/header LF/LH 585/545 but only 546 unique LCOV DA rows,
524 positive. This discrepancy is unresolved. No native percentage or coverage
floor pass is claimed; the formal coverage gate remains incomplete. No reporter
or product behavior was changed to force a passing result.
The all-source Node diagnostic includes all 106 production JS/JSX files and
28 unloaded files as zero: 3,490/12,380 lines overall (28.19%) and 3,207/6,038
core lines (53.11%). Production source hashes matched before and after collection.
This is incomplete diagnostic evidence, not production WebView or native coverage;
the 70% overall and 85% core floors remain unproven. Loaded-file percentages in
older entries do not establish application coverage.

The resource-only comparison predates later UI/default changes: help became faster,
but measured idle CPU increased. No causal or general resource-gain claim is made.
A later native UI/defaults snapshot verified dark disabled buttons, the earlier
four sidebar names and unchecked monitoring options. The user then stopped
Computer Use; later Services/layout, enabled/light/narrow/scaled UI checks remain
unverified. No further Computer Use was performed. Final headless shipping build
and native coverage evidence are recorded separately when available.

VM checks, hypervisor installation and VM boot are prohibited and were not run.
Live ETW, privileged mutation/runtime checks, complete privilege isolation and
other release gates remain incomplete. No merge or release readiness is claimed.
Historical entries below describe their own snapshots.


## 2026-10-29: approved resource improvements in progress

The user approved all 25 resource proposals. The first five are applied and
independently reviewed: relevant 65-test subset, lint, incremental typecheck and
production build exited 0. All 17 JavaScript resource items are now applied, with a 141-test relevant subset,
lint, incremental typecheck and production build exiting 0. Independent review
accepted the source; the final dialog gate confirmation, full current-tree product
gates and final measurements are pending native coordination.
Historical results below describe their recorded snapshots, not this evolving tree.

The user explicitly prohibited VM checks, hypervisor installation and VM boot.
Those checks remain UNTESTED; no host mutation substitutes are authorized.
Isolated fake systems, scratch fixtures and read-only measurements remain available.
Existing coverage, runtime and release blockers are not waived. No release, merge,
full security completion or measured optimization gain is claimed here.


## Native operation migration in progress

The new Event Logs operation family and shared grant/plan/helper/artifact/journal
substrate passed strict x64 Clippy locally. Its isolated transaction tests,
read-only inventory probe, frontend integration, and disposable Windows VM
mutation/failure checks are not yet complete. Earlier JavaScript/native test
counts describe the preceding snapshot and do not validate this expanded tree.
Generic legacy IPC remains while callers are migrated. No complete privilege
isolation, merge readiness, or release readiness is claimed.

## 2026-10-29 authorized local review

Current status: **Development only / no merge or release readiness claim.**
The user authorized validation, superseding the earlier test deferral. Locked
npm dependencies were restored with npm ci. ESLint, incremental TypeScript and
frontend production build checks passed. The safe full JavaScript suite passed 274/274 tests (exit 0). Node experimental
coverage reported 70.00% lines, 80.39% branches and 48.58% functions for loaded
JavaScript files. This excludes the unexercised GUI/native runtime and does not
establish 85% core coverage. Native formatting, strict all-target x64 MSVC Clippy and all-target tests
passed (exits 0): 19 unit and 2 manifest tests. One opt-in read probe was ignored
in the default suite; its separate run passed only exact AccessDenied
classification on this host. Elevated inventory contents, helper UAC/cancellation
and restore-point deletion were not tested. Admin-required providers may prompt
for UAC during typed inventory reads. Old scorecard figures below are historical
and have not been upgraded without whole-product evidence.

Independent review accepted the implemented recovery, backup, firewall,
history, export, event-log and native slices. Full typed privileged-operation
migration remains incomplete. No destructive client-OS matrix, packaged GUI,
NVDA/keyboard/scaling certification, signing, install/upgrade tests, runtime
benchmarks or comprehensive penetration assessment was performed. Loaded-JS
coverage is not whole-product/native coverage, and core coverage floors are not
established. Repository merge/release blockers remain.

## Historical scorecard

Updated: 2026-10-28. Status: **Fail / development only; no release or merge approval**.

This scorecard records evidence from CLI safety, native gate repair and packaging.
Unmeasured areas remain below the bar; these scores describe evidence readiness,
not a comprehensive assessment of every existing feature. No major waiver is
assumed. Scores use 0 absent, 1 ad hoc, 2 partial, 3 meets the bar with evidence,
4 exceeds it, 5 leading-program level. Release requires at least 85/100, every
dimension at least 3, and no Fail.

| Dimension | Weight | Score | Verdict | Evidence / missing requirement |
|---|---:|---:|---|---|
| Correctness | 14 | 2 | Fail | 181 JS tests and 10 native tests pass (x64); whole-product runtime matrix incomplete |
| Security & privacy | 12 | 1 | Fail | CLI no-side-effect regressions and scoped risk notes; complete Tier 2 review/SBOM absent |
| Robustness | 11 | 3 | Pass | Invalid-input and initialization-failure tests; the 2026-10-28 audit added failure drills for damaged on-disk state (interrupted-removal record) and concurrent settings writes; the follow-up pass made every state write atomic and made damaged settings/groups/Debloat-state files quarantine-and-report instead of silently resetting |
| Feature completeness | 9 | 2 | Fail | Scoped matrix in `docs/PARITY.md`; whole-product capability review pending |
| Performance | 8 | 0 | Fail | A repeatable baseline now exists (`npm run perf`: production bundle bytes + test-suite wall time, first recorded 2026-10-28); qualified budgets not yet established |
| Maintainability | 7 | 2 | Fail | Scoped decision record and isolated parser; repository-wide complexity check pending |
| Modularity | 6 | 2 | Fail | Pure parser -> dispatcher -> backend -> system boundary reviewed for this slice only |
| UX & accessibility | 6 | 1 | Fail | CLI help/errors updated; no runtime keyboard/screen-reader matrix performed |
| Scalability | 5 | 1 | Fail | Deterministic invalid-input corpus; no application 10x/100x exercise |
| Idiomatic quality | 5 | 2 | Fail | Rust formatting and strict all-target Clippy pass (x64); JS lint/type checks not configured |
| Test & corpus evidence | 5 | 2 | Fail | Parser coverage measured; full application coverage floors not established |
| Self-documentation | 4 | 2 | Fail | Parser contract and architecture notes; application API documentation incomplete |
| Documentation | 4 | 3 | Pass | CLI help now lists every working command (the 2026-10-28 audit found and fixed three missing); README and the feature guide are maintained per release |
| Diagnostics & supportability | 4 | 1 | Fail | Existing CLI errors/exit codes; stable error IDs and diagnostics bundle review pending |

Weighted total: **34.4/100** (sum of weight × score / 5).

This change should remain a draft until the full gate can pass. Validation details,
adversarial-review findings, and platform constraints are recorded in
`docs/DEVELOPMENT.md`. Application-wide gaps are follow-up work, not silently waived
release requirements.
