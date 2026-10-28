# Development record

## 2026-10-26: native gate repair and Windows distribution

Scope: repair the reported formatter, four Clippy findings and elevated test
harness, audit branding, and implement the requested three-file release layout.
No removal operation or persisted data format changes. This is a development
milestone, not whole-product release certification.

- Default development/test manifests use `asInvoker`. Cargo release profiles keep
  the original manifest exactly. Manifest tests check both cases and preservation
  of DPI, common-controls and OS compatibility declarations.
- Registry string decoding now shares one implementation using fixed-size chunks;
  malformed UTF-16 retains the prior lossy/trailing-byte behavior. Named snapshot
  tuple types remove type-complexity findings without changing storage. Tests cover
  Unicode, embedded NULs, malformed input and gzip snapshot comparison/truncation.
- The new x86 build exposed WOW64 redirection in the old bare system-tool lookup.
  `windows_tools.rs` selects Sysnative helpers from x86 on x64 Windows, System32
  helpers otherwise, and preserves explicit/custom executable paths. Backend
  Program Files roots include the native folder and the x86 folder. Native registry
  reads select the 64-bit view explicitly, matching the existing snapshot reader;
  Windows ignores that flag on a 32-bit OS. Desktop program labels use OS bitness.
- Repository-wide Rust formatting is applied. The large native diff includes
  formatting-only changes in existing modules.
- Current branding is Purgeon. Two stale npm lockfile package names were corrected.
  Legacy SweepUninstall identifiers remain only for existing data, package identity,
  task cleanup, shell integration and documented migration compatibility.
- `npm run dist:windows` builds the x64 NSIS installer, then emits exactly
  `Purgeon-Setup-x64.exe` and `Purgeon-Portable-x64.zip`. Purgeon is x64-only:
  there is no x86 build and no MSI.
- The ZIP has the portable executable, LICENSE and PORTABLE.txt at its root.
  Portable data lives beside the executable. The package script rejects a
  nonempty output folder and verifies PE architecture, archive membership and
  hashes. Hash evidence is internal to CI, outside the two assets.
- Tauri bundles the WebView2 bootstrapper rather than generating a PowerShell
  download action. Missing WebView2 still requires network access at installation.
  No runtime Rust/JavaScript dependency was added; NSIS and WiX are Tauri build tools.
- CI runs formatting, strict native lint and all-target tests for x86_64,
  builds the packages, tests install/uninstall on a disposable
  x64 runner, uploads/downloads the packages and verifies their original hashes.
  Installer mutation tests refuse to run outside GitHub-hosted runners.

### Current evidence

- **Verified locally:** 91/91 JavaScript tests, production frontend build, Rust
  formatting, strict all-target Clippy, and all 10 native tests on x86 and x64.
  The binary test harness now launches without administrator rights on both targets.
- **Verified locally:** the new native-helper test actually starts PowerShell and
  checks that its process bitness matches Windows. An x86 reproduction of the old
  bare lookup fails this assertion on the x64 host. Pure tests cover tool paths,
  custom-program preservation and native/32-bit Program Files roots.
- **Verified locally:** 3 harmless installer dispatcher probes cover architecture
  selection, failure code propagation, quoted arguments, silent mode and default/
  explicit installation paths. Four negative package checks reject nonempty output,
  extra assets, altered archives and altered archive entries.
- **Verified locally:** packaged development x86 and x64 portable copies return help
  with exit 0 and reject `--maintenance --dry-run` with exit 1. No maintenance
  operation runs. Startup creates WebView runtime data, including Crashpad settings.
- **Verified in CI:** [run 40364098101](https://github.com/SeanShaffer88/Purgeon/actions/runs/40364098101)
  on code commit `28a2f65` passed 91 JavaScript tests, formatting, strict Clippy and
  all 10 native tests per architecture. It built all three files with full MSI
  validation, passed the dispatcher/integrity probes, installed and uninstalled
  the x86 MSI and native x64 EXE on the x64 runner, verified paths with spaces and
  removal of all four scheduled tasks, then re-downloaded the artifacts and
  verified original contents and hashes. The test harness now preserves native
  exit codes across repeated task queries; a local shadow variable had caused
  a false cleanup failure and was reproduced before correction.
- **Local packaging limitation:** local WiX validation
  failed because the machine lacks its VBScript validation prerequisite (2738).
  An assembly-only local MSI was used to exercise package metadata/archive/hash
  checks without claiming ICE validation. Validation is not disabled in CI.
- **Unverified:** native 32-bit Windows 10 runtime behavior, upgrade/downgrade matrix,
  missing-WebView2 installation, full GUI/accessibility/performance coverage and
  broader quality requirements. Full x86 filesystem/ETW behavior under WOW64 is
  not certified by the helper tests. No new release is tagged or declared shipped.

### Review and sources

The integrator's adversarial reread covers manifest privilege changes, shared
decoder equivalence, fixed package names, portable activation, architecture
selection, silent argument forwarding, child exit codes, MSI upgrade conditions,
output preservation and CI permissions. One issue found and fixed: NSIS removes
`/D=` from `$CMDLINE`, so the wrapper must forward its saved `$INSTDIR` separately.
Private profile instructions and local paths are excluded from the repository.

Sources checked: [Cargo profile environment](https://doc.rust-lang.org/cargo/reference/environment-variables.html),
[Tauri Windows packaging](https://v2.tauri.app/distribute/windows-installer/),
[NSIS command-line variables](https://nsis.sourceforge.io/Docs/Chapter4.html), and
[MSI platform constraints](https://learn.microsoft.com/en-us/windows/win32/msi/template-summary).
Native-helper selection follows [Microsoft's Sysnative guidance](https://learn.microsoft.com/en-us/windows/win32/winprog64/file-system-redirector).
The earlier record below is historical; its native blockers are repaired above.

## 2026-10-26: command-line validation

Scope: a focused safety fix on the existing Rust/Tauri/React application, based on
commit `496e30e`. Purgeon serves Windows users managing programs, leftovers,
snapshots, and recovery. This change improves the existing command-line workflow;
it does not add removal commands, change backup formats, or change release privileges.
The existing Windows 10/11 x64 support claims are not re-certified by this slice.
License and distribution remain MIT and GitHub Releases.

Estimate before implementation: 30–45 minutes for parsing, dispatch wiring, tests,
and documentation, subject to native build checks. Implementation and local
validation took about 11 minutes after checkout (initial inspection and publishing
excluded). Reusing the existing backend and test harness reduced the implementation
effort; full release readiness remains blocked as described below.

### Contract and decisions

- Parse all arguments before backend initialization or operation dispatch. Exactly
  one documented command is accepted. Its allowed options may appear once each;
  every required value must be nonblank and cannot begin with a dash. Command and
  option names remain case-insensitive; preset names remain lowercase.
- Reject `--help` mixed with an operation. This makes an ambiguous request fail
  without executing it. Previously only the first recognized switch was used.
- Keep existing snapshot, monitor, maintenance, and autostart operation implementations.
  No new dependency, persisted format, system action, or network feature is introduced.
- Native launch classification recognizes complete window launch requests. It
  preserves `--tray`, `--resume-queue`, `--started-by-windows`, `--who-owns <path>`,
  and `--uninstall-target <path>`. Other arguments reach CLI validation.
- The pure parser is in `src/cli-args.js`; `src/cli.js` dispatches only its validated
  result; `src/main.jsx` supplies backend initialization after validation. Native
  window/CLI routing is in `src-tauri/src/launch_args.rs`.
- CLI help and errors still use the existing console output and exit codes. There
  are no new graphical controls. Native startup still requires WebView2 and the
  existing elevation manifest, even for help; its runtime data may be created.

### Risk and test boundary

Purgeon is system-changing software (Tier 2). The threat addressed here is an
ambiguous or mistyped command accidentally reaching a valid operation. For example,
`--maintenance --dry-run` previously ran maintenance because the unknown switch was
ignored. Every invalid-request regression substitutes a system layer that records
and rejects calls, including backend initialization. No real maintenance, installer,
or autostart action is performed by these new tests.

The parser's blast radius is which existing operation is called and with which
arguments. Tests cover every command's grammar, extra/missing values, mixed commands,
case handling, duplicate options, prototype-property names, help-only behavior,
initialization failure, and dispatch to snapshot/list/comparison operations. A
deterministic generated corpus inserts unknown options at every position of each
valid command. Rust tests cover native routing and recognized window launches.

This is not a complete application threat model or safety audit. Existing GUI
removal, recovery, privilege boundaries, all-command CLI coverage, and release
verification need separate work before a new release can be called ready.

### Checks and known limitations

Baseline: 52/52 JavaScript safety tests passed; `npm ci --ignore-scripts` reported
zero vulnerabilities; the Vite production build passed with two existing dynamic
import warnings. Dependencies and lockfiles are unchanged.

The repository has no configured JavaScript formatter, linter, or strict type
checker. Rust formatting already fails across existing sources. Baseline
`cargo test --locked --all-targets` compiled but Windows refused to execute the
binary test harness because its embedded manifest requests administrator rights
(OS error 740). The baseline library harness had no tests. These are full-gate
blockers, not passing checks or waived requirements.

Validation after the change (Windows x64, Node 24.22.1, Rust/Cargo 1.99.0):

- **Verified:** `npm test`: 91/91 tests pass, including 39 new CLI tests. The old
  dispatcher fails 31 of those 39 tests when substituted into the same harness.
- **Verified:** `node --test --experimental-test-coverage
  --test-coverage-include=src/cli-args.js test/cli.test.js`: parser line, branch,
  and function coverage are each 100%. This is parser coverage only.
- **Verified:** `npm run build`, `node --check` on the changed JavaScript modules
  and test, `rustfmt --check --edition 2021 src-tauri/src/launch_args.rs`, and
  `git diff --check` pass. The two existing Vite import warnings remain.
- **Partially Verified:** `cargo test --locked --all-targets`: both new library
  tests pass (25 routing cases), then the binary harness is blocked by OS error 740,
  as on the baseline. The full command fails; no elevated test run was attempted.
- **Fail:** `cargo clippy --locked --all-targets -- -D warnings` reports four
  findings in unchanged code: fixed-size `chunks_exact` in `snapshot.rs` and
  `lib.rs`, and two complex tuple types in `snapshot.rs`.
- **Fail:** `cargo fmt --all --check` remains blocked by existing formatting across
  the native sources. These findings are not suppressed or waived.
- **Unverified:** real packaged CLI/window execution, OS/version matrix, full
  application coverage and performance budgets. No new release was built or tagged.

Before release, the existing workflow also needs to package the portable executable
with LICENSE and a PORTABLE note in one ZIP; it currently emits a loose portable EXE.

### Adversarial reread

The integrator separately reread the finished diff, dispatch/startup paths, native
launch callers, tests, and documentation against all 15 anti-patterns. A sign-in
compatibility gap found during review was fixed by retaining `--started-by-windows`
and adding a native routing case. No private profile files or machine paths are
included in the change.

- Patterns 1–5: no stub behavior; invalid input and initialization failures covered;
  scope and sources explicit; complete test commands run with failures reported.
- Pattern 6: this was an explicit adversarial reread, not an independent reviewer.
  The scorecard keeps unverified areas below the release bar.
- Patterns 7–9: no GUI-only operation introduced; parser and native routing are
  small separate modules. Existing operation dispatch is preserved rather than
  duplicated. Existing large modules remain a recorded maintainability gap.
- Patterns 10–12: no new persistence/migration; parse errors exit visibly; argument
  traversal is finite and linear. Existing swallowed errors inside backend operations
  were not broadened or audited as part of this change.
- Patterns 13–15: no credentials or personal data added; no dependency added; no
  custom graphical control or new visual treatment.

### References checked

- [Node.js test runner](https://nodejs.org/api/test.html): existing test infrastructure.
- [Tauri CLI](https://v2.tauri.app/reference/cli/): native build tooling.
- [Windows application launching](https://learn.microsoft.com/en-us/windows/win32/shell/launch):
  context for preserving Explorer launch requests; no new Shell API is introduced.
