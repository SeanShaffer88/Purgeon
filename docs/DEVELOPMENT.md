# Development record

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
