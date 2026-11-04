# Reliability validation

This record covers the ten approved reliability priorities for the v1.4.3 working
tree on 2026-11-03. Local validation is recorded below; coverage and runtime gates remain open. Use [QUALITY.md](../QUALITY.md) for
the release gate and [DEVELOPMENT.md](DEVELOPMENT.md) for historical limitations.
Passing focused tests does not establish final native or packaged behavior.

The original CI run had seven native failures. The two-file CI short-path
correction passed local root checks: 168 native tests (166 unit plus two manifest,
two ignored), formatting and strict locked all-target x64 Clippy, all exit 0
(`../analysis-logs/ten-ci-corrected-native-checks.json`). Review
`20261104T042931Z-b6af90967538` accepted the implementation and requested the
distinct-alias fixture assertion, now added. Its focused rerun and new CI are
pending. The unchanged JavaScript suite passed 594 tests. Coverage and package
results below are previous-snapshot evidence predating the two-file correction;
no new coverage percentage or packaged pass is claimed. The 85% core / 70%
overall coverage floors remain unchanged and unmet.

## Status by priority

| Priority | Evidence and remaining work |
| --- | --- |
| 1. Terminal rollback receipts | Recovery receipt changes and JavaScript regressions are included in the working tree. Final native gates passed (167 tests); privileged runtime remains unqualified. |
| 2. Per-item restore cancellation | Restore cancellation changes and interrupted-recovery regressions are included. Actual privileged recovery remains unqualified. |
| 3. Cross-process recovery leases and bounded native execution | Final native gates and independent containment review passed. Ordinary execution retains baseline unlimited `Command.output`; only recovery-token execution is bounded, with a scoped API regression. |
| 4. Crash/restart regressions | Recovery and checkpoint regressions are included in the JavaScript suite. They exercise controlled fixtures, not recovery of real installed software after a host crash. |
| 5. Packaged CLI tests | The earlier candidate passed nine safe help/invalid-request cases and package verification. It was moved to `../analysis-logs/ten-earlier-candidate` after the ordinary-execution correction. The corrected candidate build, safe CLI suite and package regressions all exited 0. |
| 6. Keyboard and screen reader checks | An actual Windows WebView using the baseline native binary and current Vite frontend verified dialog focus trapping, Escape dismissal and palette keyboard navigation. Immediate palette typing failed before the focus fix and passed afterward. Actual Narrator speech recap confirmed only the current onboarding step after the decorative-dot fix. Final packaged UI, NVDA and the full DPI/theme/locale matrix remain unverified. |
| 7. Prior-version upgrade, reinstall and uninstall | The disposable GitHub-hosted runner workflow and installer harness are prepared with a pinned v1.4.2 prior installer. Actual lifecycle CI remains pending. No host installer was run. The harness checks inert preservation fixtures; it does not qualify real recovery data or running-instance upgrades. |
| 8. Privileged transport failure matrix | Focused worker evidence reports nine transport tests and twenty native event tests passed, with one ignored test. Independent source review accepted commit-uncertainty and cancellation handling. Final root native gates passed; actual UAC/privileged runtime checks remain pending. |
| 9. Native coverage accounting and measurement | Fresh collection maps all 32 Rust files and cross-checks exact JSON segments against LCOV. Alias filters and restart-query descriptors are corrected. Accounting completes with no incomplete reasons but exits 1 (`below-floor`); see measurements below. No production WebView workload was collected. |
| 10. Large backend benchmarks | All 210 child runs passed across ten fresh-process repeats and 1,000/10,000/100,000-item fixtures. The actual backend runs through an in-memory adapter with correctness, cancellation, denial and alias checks. These measurements do not establish real-disk performance, application budgets or an improvement over a prior build. |

## Recorded local checks (previous snapshot before the CI short-path correction)

The final Node run passed 594/594 tests (execution exit 0). Its collector exit 2
reflects only the expected missing native input before combined accounting.
Formatting, strict locked all-target x64 Clippy and native tests passed on Rust
1.99.1: 165 unit plus two manifest tests, two ignored; process and runner exits 0.
Lint, typecheck and frontend build passed on unchanged frontend source. Earlier
type-declaration and native failures are superseded by these corrected gates.
Independent review `20261104T023132Z-6252d5350d7f` accepted the final ordinary-exec
and coverage corrections with no blockers.

Combined diagnostic coverage reports JavaScript overall 4,726/13,405 (35.26%)
and core 4,439/6,812 (65.16%); Rust overall 5,020/14,423 (34.81%) and core
5,020/14,410 (34.84%). Matching Rust 1.99.0 / LLVM 23.1.1 collection tests and
exports exited 0 with source unchanged. The reporter exits 1 because the 85% core
and 70% overall floors fail, despite an empty `incompleteReasons` array. This
resolves current accounting errors, not workload qualification or coverage floors.

Local evidence remains outside the repository under `../analysis-logs/`:

- `ten-node-complete/stdout.log` and `execution.json`: final 594-test run.
- `ten-native-preserved-checks.json`: final native gates and native log locations.
- `ten-corrected-checks.json`: lint, types and frontend build; its earlier native
  failure is superseded by the preserved native checks.
- `ten-native-collection/20261104T023055Z-716edeb3/result.json`: matching native
  collection; `ten-coverage-complete/report.json` and `execution.json`: accounting.
- `ten-final-package-checks.json`: corrected candidate build, CLI and package regressions all exited 0 (process and runner).
- `ten-package-checks.json`: earlier candidate CLI 9/9 and package verifier with
  zero failures. Independent artifact review `20261104T022323Z-2d920f93559e`
  recorded static package/portable PE checks exit 0, x64 and matching hashes.
  Its separate ZIP recheck was blocked by Constrained Language Mode (exit 1);
  the coordinator's package verifier exited 0. These predate the corrected build.
- `ten-ui/runtime-results.json`: six actual frontend checks and keyboard/Narrator
  observations. Computer Use provided no process exit code.

The final benchmark report is retained locally at
`%TEMP%/Purgeon-verification-f6384485/backend-benchmark-final-ten.json`.
UI screenshots remain private because installed application names are visible.
The owned application, Narrator and Vite instances were closed after the checks.

## Reproduction interfaces and remaining gates

The existing full gate requires `npm ci`, `npm test`, `npm run lint`,
`npm run typecheck` and `npm run build`. From `src-tauri`, run formatting with
`cargo fmt --all --check`, then strict locked Clippy and tests with the explicit
`x86_64-pc-windows-msvc` target and `--all-targets`. Preserve every failure and
rerun affected checks after source corrections. Final native results are recorded above.

The additional validation entry points are:

- [`scripts/test-packaged-cli.ps1`](../scripts/test-packaged-cli.ps1) for safe
  packaged help and invalid-request cases. The corrected candidate rerun passed.
- [`scripts/test-windows-installers.ps1`](../scripts/test-windows-installers.ps1)
  and [the Windows workflow](../.github/workflows/release.yml) for disposable
  installer lifecycle checks. The script rejects execution outside a disposable
  GitHub-hosted runner and requires the prior version and SHA-256.
- [`scripts/benchmark-backend.mjs`](../scripts/benchmark-backend.mjs), which accepts
  a new output JSON path and a repeat count from 1 through 10.
- [`scripts/collect-native-coverage.mjs`](../scripts/collect-native-coverage.mjs),
  which accepts a target directory, matching LLVM binary directory and new output
  directory. Collection and accounting must use matching toolchains and frozen
  product inputs before percentages can be claimed.

Build Windows artifacts with the existing `npm run dist:windows` interface only
after the applicable local gates. Candidate validation must verify exactly
`Purgeon-Setup-x64.exe` and `Purgeon-Portable-x64.zip`, including downloaded hashes
and ZIP contents. There is no x86 or MSI artifact. Pending CI, runtime and coverage
gates prevent a release-readiness claim; this record authorizes no tag or release.

## Tooling limitations

The coordinator's authenticated loopback XERJ dry-run exited 4: disk usage was
97%, above the 95% watermark, with 20.9 GB free, a zero budget and a 5.7 MB
estimate. No index or search passed. The owned node was stopped, guards were
preserved and targeted current-source reads replaced indexing. Authenticated Codex CLI workers ran via the Ruflo launcher after the MCP request timed out at 120 seconds; no live MCP success is claimed.

## Module boundaries

The approved boundary is UI/API → backups → sys → tauri-sys → native lease/worker
→ process_io/security/broker. JavaScript has one configured context per module;
native recovery uses a per-root cross-process lock. Provider completion remains
deferred. These are cohesive internal modules; a separate package has no second
consumer to justify extraction (architect review `20261104T022942Z-7c8938cfebdd`).
