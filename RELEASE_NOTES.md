# Purgeon 1.5.0-alpha.1 — reusable feature preview

Purgeon's backend now lives in the dependency-free `purgeon-core` ESM package. The desktop app uses the same canonical implementations through compatibility wrappers. Consumers can import individual feature APIs or pure helpers; the package documents its operations, dependency closure and host requirements.

- 269 named operations preserve application dispatch, approval, backup and recovery checks. Public effectful calls require explicit approval inside operation admission.
- Host registration and initialization are explicit. One host/data identity is supported per canonical loaded package instance in a JavaScript realm.
- Measurement consumers can subscribe to isolated results and unsubscribe.
- Tauri integration, native broker operations, CLI dispatch, DOM changes and application lifecycle stay app-owned. No standalone Rust crate or ready-made Node host is supplied.

Local validation passed: 567 application tests, lint, incremental typecheck, frontend build, eight packed offline-consumer modes, native formatting, strict locked x64 Clippy, 143 native tests (two additional probes ignored), Windows packaging, package-verifier failure tests and native CLI help. Independent review passed after correcting the relocated native catalog path and measurement result access.

The Windows x64 assets are `Purgeon-Setup-x64.exe` and `Purgeon-Portable-x64.zip`. The ZIP contains `Purgeon-Portable-x64.exe`, LICENSE and PORTABLE.txt. Local artifacts are unsigned. The reusable package tarball is a separate development artifact; build it with `npm pack ./packages/purgeon-core --ignore-scripts`. No npm registry publication is configured.

This is an alpha prerelease. Mock and static checks do not establish live privileged mutation, UAC, ETW, installer lifecycle, recovery, accessibility or broad OS compatibility. The 85% core and 70% overall coverage floors remain unproven. See the package README and capability inventory for contracts and limitations.
