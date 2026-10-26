# Purgeon project rules

Standards: Elite Software Master Prompt v1.1; desktop and CLI annexes A1/A4 and
the owner's project defaults apply. Private profile guidance is not stored here.

Purgeon helps Windows users inspect, remove, and recover installed software and
its leftovers. Preserve its Rust/Tauri/React stack and existing data identity.
The current maintenance slice is specified in `docs/DEVELOPMENT.md`.

- UI calls application operations in `src/backend/api.js`; backend modules use
  `src/backend/sys.js`. Native system access lives in `src-tauri`. Do not move
  system-changing behavior into UI handlers.
- CLI validation is pure (`src/cli-args.js`). Dispatch and backend initialization
  happen only after the entire request passes. Preserve native window launch
  arguments when editing `src-tauri/src/launch_args.rs`.
- Preview, backup/recovery, conservative selection, and pre-delete checks are
  safety contracts. Tests must never clean up real installed programs or user data.
- Keep lockfiles, regression tests, help, and behavior documentation together.
  Public text must not claim untested compatibility or runtime behavior.
- Full checks: `npm ci`, `npm test`, `npm run build`, then from `src-tauri`,
  `cargo fmt --all --check`, `cargo clippy --locked --all-targets -- -D warnings`,
  and `cargo test --locked --all-targets`. Run lint/tests with `--target` for both
  `i686-pc-windows-msvc` and `x86_64-pc-windows-msvc`. Record every failure; a passing subset
  does not replace the full gate. JavaScript lint/type gates remain to be established.
- Coverage floors are 85% core, 70% overall, and every safety-relevant/destructive
  path exercised. Parser-only coverage does not establish application coverage.
  Application performance budgets are not yet established; do not invent results.
- Do not merge or tag a release while full-gate blockers remain. Windows releases
  require exactly `Purgeon-Setup.exe`, `Purgeon-Setup.msi`, and `Purgeon-Portable.zip`,
  built with `npm run dist:windows`. The EXE selects native x86/x64; the MSI installs
  x86 on either OS; the ZIP contains both portable builds, LICENSE and PORTABLE.txt.
  Verify downloaded contents/hashes. Installer mutation tests run only on disposable
  GitHub-hosted runners. Never describe the MSI as selecting native x64.

Test corpus: `test/`, with native routing cases in `src-tauri/src/launch_args.rs`.
Decisions and limitations: `docs/DEVELOPMENT.md`. Capability evidence:
`docs/PARITY.md`. Release gate status: `QUALITY.md`.
