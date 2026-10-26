# Capability evidence

Updated: 2026-10-26. Scope: command-line validation, native gate repair and packaging.
This is not an exhaustive feature audit or a claim that all roadmap work is done.

Completeness claim for this slice: every supported CLI command validates its full
request before initialization/dispatch; malformed input produces exit code 1;
valid argument values reach the existing operations; recognized window launches
retain their route. Whole-product release readiness remains blocked by the checks
listed in `QUALITY.md`.

| Area | Verdict | State | Evidence / remaining gap |
|---|---|---|---|
| Full CLI grammar validation | Include | Verified in tests | 39/39 CLI tests; parser line/branch/function coverage 100%; all command forms, missing/extra/duplicate values, mixed commands, option typos, prototype names |
| No operation on invalid input | Include | Verified in tests | 32 invalid-request tests assert zero initialization/system calls |
| Valid command dispatch | Include | Partially Verified | Snapshot, comparison/report, list and initialization failure integration tests pass with a substituted system layer; real app operations not exercised |
| Help without backend initialization | Include | Verified in tests | Six help/empty-input variants pass; native WebView startup is still required |
| Native launch routing | Include | Partially Verified | 25/25 routing cases in two passing Rust tests; packaged application runtime remains unverified |
| CLI uninstall / leftover scan / cleaner | Defer | Not part of this fix | Existing roadmap; needs operation-specific safeguards and tests |
| Native formatter/linter/test gate | Include | Verified locally | Formatting passes; strict all-target Clippy and all 10 native tests pass on both x86/x64 |
| x86 helper/registry view on x64 Windows | Include | Verified in scoped tests | Real PowerShell bitness check passes; old x86 helper lookup reproduces the failure; full feature parity remains unverified |
| Universal Setup EXE | Include | Implementation complete; CI pending | Delegates to existing native installer; silent switches and return codes preserved |
| One MSI for both Windows architectures | Include | Implementation complete; CI pending | x86 MSI runs on either architecture, installs x86 app; native x64 selection inside one MSI is unsupported |
| Portable distribution | Include | Implementation complete; CI pending | Both executables, shared adjacent data, LICENSE, PORTABLE.txt; content/hash verification |
| Full release validation | Investigate | Blocked | Whole-product evidence gaps in `QUALITY.md`; 32-bit Windows runtime matrix outstanding |

The generated invalid-option corpus inserts 32 distinct unknown switches at every
position in seven valid command examples: 608 requests. It supplements named
regressions; it is deterministic adversarial testing, not a general fuzzing claim.
