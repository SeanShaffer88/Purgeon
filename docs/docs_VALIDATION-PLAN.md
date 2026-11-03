# Deferred validation plan

> Historical implementation/validation snapshot. Its counts and deferred-work
> instructions describe that earlier revision. See [QUALITY.md](../QUALITY.md)
> for current executed evidence and remaining gates. VM checks, hypervisor
> installation and VM boot are explicitly prohibited by the user. Any VM scenario
> retained below is historical planning, not an authorized instruction to run it.


The 2026-10-29 review authorized local validation, superseding the earlier
no-further-tests instruction. See QUALITY.md for executed checks. This remaining
plan covers packaged runtime, failure, accessibility and performance scenarios;
source/unit checks do not establish these scenarios passed. Executed native
gates passed formatting, strict x64 Clippy and 21 tests; the separate inventory
probe covered only exact AccessDenied classification. Verify elevated typed
inventory contents, UAC refusal/cancellation and deletion in disposable client VMs.

For subsequent changes, run the repository gate using its actual x64 MSVC
target: npm ci, npm run lint, npm run typecheck, npm test, npm run build; then Rust
format checking, strict all-target Clippy and all-target tests with
`--target x86_64-pc-windows-msvc`. The TypeScript gate is incremental: contracts and
the production system adapter, not a repository-wide migration.

## Packaged runtime and failure drills

- Use disposable Windows 10 and Windows 11 client VMs, elevated and standard user,
  installed and portable mode, existing and absent WebView2, and paths containing
  spaces/non-Latin characters. Server CI images do not certify client support.
- Exercise inventory -> details -> dependency review -> uninstall -> leftovers ->
  dry run -> removal -> restore. Include MSI, Inno, NSIS, Store, missing metadata,
  cancelled uninstallers and restart-required queues. Never use this host's real
  programs or files for destructive scenarios.
- Exercise every API2 declarative-plugin decision: absent approval, disabled,
  changed rules/version, traversal/stream/device paths, protected locations,
  oversized manifests and result bounds. Verify no script.js executes.
- Feed migration packages conflicting manifest/.reg targets, deletion directives,
  multiline hex, duplicate ZIP destinations, rooted/relative/ADS/device aliases,
  reparse ancestors, compression bombs, corrupt streams and partial writes. Verify
  preflight and recovery evidence before each actual mutation.
- Inject failures before and after every recovery checkpoint. A failed mutation
  must not become a committed undo entry, an uncertain intent must halt further
  mutations, and Dismiss must leave the journal intact. Test concurrent GUI/CLI
  requests and scheduled/Explorer launches against the single-state-owner policy.
- Verify per-data-root secret vaults with two portable roots, key rotation,
  clearing the active key, wrong keys, oversized/corrupt DPAPI data and moving
  backups between machines. Existing encrypted manifests need their original
  password; the local DPAPI ring is not a cross-machine key backup.
- Verify process PID reuse, creation-time mismatch, unreadable identities, current
  executable under installed/portable names, critical process detection and undo.
- Inspect secure-erase bytes on disposable scratch files for every pass, with
  cancellation, hardlinks, symlink/junction races and file identity substitution.
  File overwrites are not a guarantee of physical media sanitization.
- Exercise denied/throttled restore-point creation and persistent boot settings
  with VM recovery snapshots. Verify native UAC/helper request binding once the
  privileged broker is implemented; raw script endpoints are not equivalent.
- Run keyboard-only, screen-reader, high-contrast, 200% scale and all supported
  language workflows. Verify stacked dialogs, focus return, list sorting,
  virtualization and destructive confirmation labels.
- Verify signed app, installer, extracted portable executable, hashes and
  downloaded artifacts after packaging; verify absence of credentials in logs.

## Application benchmark protocol

Record CPU/model, RAM, storage, Windows build, display scale, power mode and commit.
Measure at least five cold and warm startup runs; idle CPU/RAM over ten minutes;
search/sort/scroll with 1,000 and 10,000 synthetic programs; quick/standard/deep
snapshot time, memory and cancellation latency; foreground process-sampling
overhead; and large migration preflight/copy duration. Store raw measurements and
median/p95 results. Establish budgets only from these measured workloads; do not
substitute JavaScript bundle size or unit-test wall time for application speed.

This is a plan for a bounded penetration assessment, not an assertion of
exhaustive security coverage or a completed penetration test.
