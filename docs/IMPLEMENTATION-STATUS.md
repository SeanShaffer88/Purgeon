# Hardening implementation status

> Historical implementation/validation snapshot. Its counts and deferred-work
> instructions describe that earlier revision. See [QUALITY.md](../QUALITY.md)
> for current executed evidence and remaining gates. VM checks, hypervisor
> installation and VM boot are explicitly prohibited by the user. Any VM scenario
> retained below is historical planning, not an authorized instruction to run it.


Updated 2026-10-29. **Locally checked / development only / not release ready.**

The current review supersedes the earlier request to defer tests. The user
approved the ten prioritized improvements. Recovery evidence retention, verified
task/firewall backups, conservative firewall restoration, native lint fixes,
exact restore-point removal, history integrity, atomic file replacement,
staged package export and atomic event-log save-and-clear have been implemented
and independently source-reviewed. Full privileged-operation migration (#4 of
the current review) remains incomplete; generic privileged shell/command routes
still exist. This is not a complete security boundary or product certification.

Current executed checks: npm ci, lint, incremental typecheck, 274 JavaScript
tests with Node experimental coverage, and the frontend build all exited 0.
Native formatting, strict x64 MSVC Clippy and all-target tests also exited 0
(19 unit + 2 manifest tests). The separate read probe verifies only exact host
AccessDenied classification, not elevated contents or UAC/deletion behavior.
Remaining gates and coverage limitations are recorded in QUALITY.md. No
installer, signing, destructive Windows operation, accessibility matrix or
performance benchmark was run. Changes remain local pending all repository
merge requirements. Tags and releases require explicit user approval.

## Historical 20-recommendation ledger

The following ledger describes the earlier implementation scope; its unrun
runtime scenarios remain outstanding unless current evidence explicitly says
otherwise.


| # | Recommendation | Actual implementation | Remaining work / validation |
| --- | --- | --- | --- |
| 1 | WebView runtime compatibility | Replaced Node path/fs/crypto/vm usage in application modules; browser import guard; native binary-copy and tracking/version APIs | Packaged WebView feature smoke matrix not run |
| 2 | Query result contracts | Single-object response validator; process result unwrapping; one-object battery query | Real Windows result/permission/locale fixtures not run |
| 3 | Plugin isolation/approval | Executable JavaScript plugins replaced by bounded declarative API2 rules; approvals tied to rule/version digest; disabled/changed/unapproved rules refused | Deliberate API1 breaking change; no arbitrary-script compatibility; adversarial fixtures not run |
| 4 | Untrusted migration packages | Kind/target/schema validation; actual .reg target constraints; bounded manifest/ZIP expansion; all selected archive destinations preflighted before mutation | Race/adversarial VM drills not run; native extraction migration remains part of broker work |
| 5 | Encryption secrets | Per-canonical-data-root DPAPI vault stored locally; legacy settings migration; safe preference sync excludes secrets; prior passwords retained for old backups | Vault/keyring and cross-machine recovery not run; only manifests are AES-GCM encrypted, payload .reg/XML/files are not |
| 6 | Privilege boundary | asInvoker launch; least-privilege new tasks; typed native process actions and 136 catalog-resolved Debloat operations; native consent/authenticated live helpers; authority-bound native Debloat originals/journals; clean elevation handoff | **Partial:** other operation families still expose generic shell/command IPC, including in transitional elevated GUI; full boundary migration required (PRIVILEGE-BROKER.md); native slices uncompiled/unrun |
| 7 | Durable recovery | Separate intent/completion records; halt at uncertain mutation; preserve evidence on Dismiss; import undo entries only after successful mutations; native process intent/result records; single state owner | Fault injection not run; unresolved state requires review, not blind replay; cross-feature recovery UI still limited |
| 8 | Live process identity | FILETIME creation identity through view/API/native plan/undo; actual opened-handle critical/self/image/identity checks, native priority/affinity/end/suspend/resume | PID-reuse/privilege/cancel/native FFI runtime gate not run |
| 9 | Retry/deadline policy | Automatic retries restricted to known reads; bounded concurrent PowerShell I/O/deadline/job lifetime; cancel requests bypass mutation lock | Command and descendant lifetime behavior not run; std::process spawn-to-job assignment is not sandbox isolation |
| 10 | Secure erase | Zero pass resets buffer; native pass bounds; exclusive verified handle, hardlink/reparse refusal, delete-by-handle; blocking work moved off UI thread | Native scratch-file/race/cancellation tests not run; file overwrites do not guarantee physical media sanitization |
| 11 | Bidirectional preference sync | Canonical safe-field snapshots; local baseline; field-level three-way merge; first-connection/conflict refusal; explicit conflict pull/push dialog; own-state folder rejection | Concurrent cloud-provider/reparse/runtime drills not run |
| 12 | Installer attribution | Snapshot-only changes tagged unattributed/low confidence; trials leave them unchecked; traced evidence overrides duplicate timing-only records | ETW attribution and overlapping application workloads not run; host monitoring is not VM isolation |
| 13 | Ownership evidence | Name-only matches lowered/unchecked; evidence labels replace probability-looking percentages | Collision/non-Latin/shared-data fixtures not run |
| 14 | Portable generation | Native binary-safe copy and held-handle hash verification; failed required copies no longer produce text executables; direct input record normalization; safe single-root relative destinations | Portable launcher/package runtime not run; unsupported app portability is not promised |
| 15 | Restore/boot safety | New restore point verified by new sequence/description; persistent Safe Mode wording/recovery guidance | Disposable-VM restore/boot/locale validation not run |
| 16 | Destructive confirmations | Negative/cancel does not remember; destructive prompts cannot be suppressed; conservative focus/action labels; Pause undefined-variable defect fixed | Keyboard/native consent matrix not run |
| 17 | Interface hierarchy | Separate action-toolbar component, reduced primary actions/More, optional visible navigation labels, double-click inspection; mockup supplied | No rendered/runtime validation |
| 18 | Accessibility/English-only UI | Shared modal stack/focus/inert management, bounded list selection/progress semantics, English-only catalogs/settings/import normalization and removal of language choices | Actual NVDA/keyboard/scaling checks not run; foreign-language translation is out of scope by user instruction |
| 19 | Performance | Real cold namespace imports; bounded row windowing; removed forced GPU-disable; distinct toolbar/controller code; native process control avoids per-action PowerShell | **Partial:** runtime benchmarks/budgets not measured; full App component decomposition is not complete |
| 20 | Release/integration gates | User-approved development-only ESLint/TypeScript dependencies; incremental adapter contract gate; browser API guard; absolute-path native signing command; immutable workflow-action commit pins with provenance; deferred regression source/manual matrix | Gates/signing/Windows client matrix not run; whole-product TypeScript migration and release assurance remain incomplete |

## Breaking changes and migration limits

- Plugins now use API version 2 with explicit exact-path declarative file/directory
  rules. `script.js` is never evaluated. A legacy API1 plugin is shown unsupported;
  it must be translated to declarative rules and explicitly enabled. Validation
  reports integrity and never approves changed content automatically.
- Application startup does not automatically require administrator rights. Newly
  registered Purgeon tasks request Limited privileges. This does not prove old
  Highest tasks were successfully downgraded on upgrade; existing tasks may require
  administrator-assisted migration. Transitional GUI elevation remains available
  until native operation-family migration is complete.
- Valid legacy local settings passwords are moved into the per-data-root local
  DPAPI keyring before preference export/use. This cannot erase an already-synced
  password from a cloud provider's version history, another machine, or a prior
  export. Consider rotation and retain old passwords for existing encrypted data.
  The keyring is tied to Windows user/machine and effective data-root identity;
  moving portable data may require re-entering the original password.
- Manifest AES-GCM does not encrypt registry/task payloads or Recycle Bin files.
  Backup fingerprints detect accidental changes; unkeyed hashes are not proof of
  authenticity against an attacker who can rewrite both content and hashes.
- If an operation outcome is uncertain, recovery records remain intact and
  automatic replay/rollback is refused until the affected state is reviewed.
- Native Debloat restores first captured raw value types/absence within its
  authority, or explicitly confirmed catalog defaults when no trusted original
  exists. It retains empty created registry keys to avoid deleting concurrent
  values. Old renderer JSON originals never authorize an elevated restore.
  User snapshots use DPAPI for at-rest protection, not same-user attacker
  authentication. Helper originals use protected machine state. Machine leaves
  owned by SYSTEM rather than Administrators currently fail closed; compatibility
  with SYSTEM-provisioned leaves is not claimed.
- A failed or partial native Debloat transaction retains its before-state and
  uncertain intent, then blocks all further changes for that tweak, including
  restore. Automatic native rollback and a reviewed recovery-resolution flow are
  not implemented yet. Retention and fail-closed behavior are not a completed
  recovery facility.
- Only portable presentation preferences sync: theme, English language setting,
  text scale, reduced motion, and grid lines. Safety switches, approvals, secrets,
  local folders, and backups never sync through this preference mechanism.

## Working capability/toolchain index

- Stack/interface: React 19 + Vite 8 webview -> backend/api.js -> sys.js -> native
  Tauri 2/Rust. No system mutation moved into React handlers.
- Active skill: `C:/Users/Sean Shaffer/.agents/skills/vercel-react-best-practices/SKILL.md`.
  Relevant rules: bundle-conditional, bundle-analyzable-paths,
  rerender-functional-setstate, client-passive-event-listeners and rendering
  guidance. Existing React/Vite is retained; no Next.js layer is introduced.
- Read-only toolchain discovery command exited 0: Node v26.13.0, npm 11.20.0,
  Cargo/rustc 1.99.0, LLVM 23.1.1, host x86_64-pc-windows-msvc. Installed targets
  include x64, i686 and ARM64 Windows MSVC; the product target remains x64 only.
  Rust edition 2021, release opt-level=s, LTO, one codegen unit, panic=abort, strip.
- Development-only dependency lock update command (explicitly user-approved):
  `npm install --save-dev eslint @eslint/js globals typescript --package-lock-only --ignore-scripts --no-audit --no-fund`, exit 0.
  This was dependency metadata editing, not a validation run.
- Source modifications made with apply_patch have no tool-provided exit code.
  Successful Node source-editing commands exited 0. One source-editing command
  exited 1 (`Secret block not found`, CRLF match); no edits were applied by it and
  the replacement was made with a targeted patch. No failed gate is hidden.

## Required follow-up gates

See VALIDATION-PLAN.md for the pending packaged runtime, fault-injection,
adversarial, accessibility, client-OS, signing and benchmark protocols. See
PRIVILEGE-BROKER.md for the remaining closed-operation-family migration.
