# Purgeon constraints

Read before writing code. Do not weaken constraints to make a change pass.

## Owner-approved coverage replacement; merge-gated adoption

The one-time PR91 legacy transition replaces blanket 85% core / 70% overall
floors with a manual review gate using existing purgeon-coverage-v2 reports.
Historical failures remain recorded. Adoption requires fresh complete matching
Node/native evidence at one identified source commit, all applicable gates and
independent audit. The independently reviewed baseline is in coverage/baseline.json.
It activates only when PR91 merges after all required checks pass for its final head.
Missing evidence blocks adoption; this condition does not claim CI has passed.
The transition does not claim 85% pre-transition changed-line coverage passed.

After adoption, every production change must retain the last reviewed baseline
and report comparison, with these independently reviewed rules:

- JS and Rust core and overall exact ratios cannot fall against that baseline.
- Changed critical executable lines must reach 85% separately per language.
- Touched legacy critical per-file ratios cannot fall; retain an 85% floor once achieved.
- Explicit failure-path evidence covers denial, invalid input, cancellation,
  timeout, partial mutation, persistence failure, crash/restart and recovery failure.

Critical scope and categories are recorded in coverage/policy.json. Preserve v2
inventory, exclusions, core membership and hit semantics. Incomplete or unknown
native mappings cannot become empty denominators or passes. Compare exact counts,
without language blending, tolerance, dynamic waivers or automatic baseline resets.
Zero changed executable lines requires an explicit 0/0 not-applicable record.
Overall 50/60/70 milestones are aspirational. Automated CI ratchet enforcement
and new browser instrumentation are deferred; existing CI checks are unchanged.

## Independent gates

Preserve npm ci, npm test, build, lint, typecheck, packed-consumer checks, native
formatting, locked strict x64 Clippy and locked x64 native tests. Preserve safety
contracts and regression tests. Do not suppress checks, skip tests, narrow coverage
or fabricate results. Policy, baseline and collector changes require independent review.

Runtime, installer, accessibility and privileged-provider qualification retain
their own limitations. Performance budgets are not established. No merge or
release while applicable full-gate blockers remain; no alpha release tags.
