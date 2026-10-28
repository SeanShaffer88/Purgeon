# Capability evidence

Updated: 2026-10-28. Scope: command-line validation, native gate repair and packaging,
plus the whole-product feature audit of 2026-10-28 summarized below the table.

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
| Native formatter/linter/test gate | Include | Verified locally and in CI | Formatting passes; strict all-target Clippy and all 10 native tests pass (x64) |
| x86 helper/registry view on x64 Windows | Include | Verified in scoped tests | Real PowerShell bitness check passes; old x86 helper lookup reproduces the failure; full feature parity remains unverified |
| Setup EXE (x64) | Include | Verified on x64 CI runner | Silent install/uninstall and paths with spaces pass; dispatcher probes cover argument/exit forwarding |
| Architectures | Include | Verified | x64 only since 2026-10-27 (owner decision); releases attach the x64 installer and the x64 portable zip; earlier multi-architecture releases are unchanged |
| Portable distribution | Include | Verified in CI | The x64 executable, LICENSE and PORTABLE.txt; original contents/hashes verified after artifact re-download on every release through 1.0.7 |
| Full release validation | Investigate | Blocked | Whole-product evidence gaps in `QUALITY.md`; on-machine runtime checks for the newest features remain outstanding |

The generated invalid-option corpus inserts 32 distinct unknown switches at every
position in seven valid command examples: 608 requests. It supplements named
regressions; it is deterministic adversarial testing, not a general fuzzing claim.

CI evidence: [run 40364098101](https://github.com/SeanShaffer88/Purgeon/actions/runs/40364098101)
on code commit `28a2f65`. These checks establish this development slice, not a new
shipped release or whole-product certification.

## Whole-product feature audit — 2026-10-28

Every window view, command-line command and background feature was checked
against the code and the automated tests. Behavior verified by tests or by a
working-copy UI harness is marked Verified; behavior that only a real Windows
machine can prove is marked Unverified and listed as a remaining gap in
`QUALITY.md`.

Fixed by the audit (each with a regression test that failed before the fix):
a damaged interrupted-removal record threw and was silently ignored, hiding
the interrupted removal forever; two settings writes at the same time could
silently undo each other; a typed group name could impersonate a built-in
group; Disk Usage listed drives with no readable space; and three working
commands (--sync, --portableapps, --export) were missing from --help.
