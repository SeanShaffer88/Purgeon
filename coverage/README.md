# Manual coverage review

The independently reviewed [baseline](baseline.json) activates only when PR91 merges
after all required checks pass for its final head. Before that condition is met,
it is not the active baseline. Automated CI ratchet
enforcement is deferred. Existing v2 collection interfaces remain:

```text
node scripts/collect-node-coverage.mjs <new-output-directory>
node scripts/collect-native-coverage.mjs <target-dir> <matching-llvm-bin> <new-output-dir>
```

The native collector requires prepared matching instrumented build/profile inputs;
its invocation alone does not establish a complete workload or successful build.

1. Retain complete matching v2 reports, collector execution results and source
   identity at the reviewed commit. Missing or incomplete evidence blocks review.
2. Compare exact covered/executable ratios for JS/Rust core and overall separately
   against the last reviewed baseline. Retain counts and report comparisons.
3. Intersect changed critical lines with v2 executable lines; require 85% separately
   per language. Review touched legacy critical per-file no-fall and the 85% floor
   once achieved. Record 0/0 as not applicable, never as a measured pass.
4. Record each failure-path test/assertion and execution evidence, or reviewed
   applicability reason, using policy.json categories. Include the complete change.
5. Independently review policy, reports, comparisons and all applicable project
   gates before adoption/merge. Preserve prior baselines; never reset automatically.

The authorized one-time PR91 legacy transition must identify its verified source
commit and explicitly record that old floors and 85% pre-transition changed-line
coverage were not demonstrated. Future production changes have no transition waiver.

## Candidate provenance

The candidate measures source commit `448ad8f2b51f163f35f34e99fc5e16ab65b01b73`
against main base `e06ff02211d436f9409b5e1de31f295878306034` for PR91.
Its documentation commit is later, avoiding a self-hash cycle. Exact covered/executable
counts are JS overall 4835/13734, JS core 4548/7141, Rust overall 5508/14519 and
Rust core 5508/14506. The reporter exits 1 (below-floor), with no incomplete reasons;
the historical 85%/70% floors did not pass.

Each file retains its measured raw SHA256 and canonical Git blob SHA256. The
controller's binary proof verified 290 files: 8 identical and 282 differing exclusively
by CRLF-to-LF checkout conversion under system Git core.autocrlf=true. The proof
hash binds that mapping to the measured source tree and commit. Other byte
differences fail. This records checkout provenance without rebinding profiles or
changing source bytes, offsets, hashes, exclusions, core membership or denominators.

The candidate retains relative artifact paths and SHA256 references; raw evidence
stays outside the repository in the controller's analysis-logs archive. Those paths
require that archive and are not public downloads. Review the frozen report, manifest,
evidence, workload inputs, child executions and native export provenance together.
Future ratios compare by integer cross multiplication, without rounding or tolerance.
Independent review approved the evidence. Activation requires PR91's merge after
passing final-head CI; consult that PR for the hosted result rather than treating
this pre-merge record as a CI pass.

## Process spawn containment candidate

[Review record](reviews/process-spawn-containment.json) measures source commit
`e9fbb023dbbb6101eb0b9f1af6b48492c38c83f0`. It preserves all 290 file counts,
source proof, artifact hashes, exact aggregate and touched-file comparisons, and
failure-path evidence. Changed critical Rust coverage is 104/118 (88.14%);
JavaScript is 0/0, not applicable. All four aggregate ratios meet no-fall comparisons.

The earlier 122/155 changed-line result failed. ACK test fault plumbing moved
exclusively into the existing canonical `cfg(test)` test module; production
validation, authentication, normal/error ACK dispatch and waits remain measured.
The final result uses unchanged v2 rules. The reporter still exits 1 below the
historical 85%/70% floors, with no incomplete reasons; those floors did not pass.

This candidate can become the latest manual comparison reference only after
independent review and a passing final-head PR merge. Preserve the original
baseline and prior records. This record neither activates the baseline nor claims
hosted CI readiness. Its relative evidence paths require the local analysis-log
archive. Production worker entry, privileged/UAC/VM operation and full application
performance remain unqualified by these unit and Node workloads.

PR93 head `276e2ea` failed a literal current-directory spelling assertion
(`runneradmin` versus `RUNNER~1`). The test-only correction compares canonical
directory identity; passing hosted CI for the final head remains required.
