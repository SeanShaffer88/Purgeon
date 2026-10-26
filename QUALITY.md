# Quality and release gate

Updated: 2026-10-26. Status: **Fail / development only; no release or merge approval**.

This initial scorecard records evidence available during a focused CLI safety fix.
Unmeasured areas remain below the bar; these scores describe evidence readiness,
not a comprehensive assessment of every existing feature. No major waiver is
assumed. Scores use 0 absent, 1 ad hoc, 2 partial, 3 meets the bar with evidence,
4 exceeds it, 5 leading-program level. Release requires at least 85/100, every
dimension at least 3, and no Fail.

| Dimension | Weight | Score | Verdict | Evidence / missing requirement |
|---|---:|---:|---|---|
| Correctness | 14 | 2 | Fail | Baseline JS safety tests/build pass; full native gate blocked by elevation manifest |
| Security & privacy | 12 | 1 | Fail | CLI no-side-effect regressions and scoped risk notes; complete Tier 2 review/SBOM absent |
| Robustness | 11 | 2 | Fail | Invalid-input and initialization-failure tests; whole-product failure drills pending |
| Feature completeness | 9 | 2 | Fail | Scoped matrix in `docs/PARITY.md`; whole-product capability review pending |
| Performance | 8 | 0 | Fail | No qualified application budgets or benchmark recorded |
| Maintainability | 7 | 2 | Fail | Scoped decision record and isolated parser; repository-wide complexity check pending |
| Modularity | 6 | 2 | Fail | Pure parser -> dispatcher -> backend -> system boundary reviewed for this slice only |
| UX & accessibility | 6 | 1 | Fail | CLI help/errors updated; no runtime keyboard/screen-reader matrix performed |
| Scalability | 5 | 1 | Fail | Deterministic invalid-input corpus; no application 10x/100x exercise |
| Idiomatic quality | 5 | 1 | Fail | Existing Rust formatting failures; JS lint/type checks not configured |
| Test & corpus evidence | 5 | 2 | Fail | Parser coverage measured; full application coverage floors not established |
| Self-documentation | 4 | 2 | Fail | Parser contract and architecture notes; application API documentation incomplete |
| Documentation | 4 | 2 | Fail | CLI README/help/changelog updated; full documentation audit pending |
| Diagnostics & supportability | 4 | 1 | Fail | Existing CLI errors/exit codes; stable error IDs and diagnostics bundle review pending |

Weighted total: **30.4/100** (sum of weight × score / 5).

This change should remain a draft until the full gate can pass. Validation details,
adversarial-review findings, and the native test constraint are recorded in
`docs/DEVELOPMENT.md`. Application-wide gaps are follow-up work, not silently waived
release requirements.
