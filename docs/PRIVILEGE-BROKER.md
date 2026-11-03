# Privilege boundary migration — native slices implemented, unvalidated

## Scheduled-task runtime migration

Runtime task operations now use native inventory pages, opaque task/program grants,
immutable prepare/execute plans and caller-bound recovery journals. All task-family
JavaScript routes—including startup toggles, deeper scans, backup preview/removal/
recovery and Purgeon's owned sign-in/maintenance/background tasks—use this boundary.
No runtime scheduler cmdlet, `schtasks` command or generic Scheduler COM remains in
the JavaScript backend. Queue continuation uses HKCU RunOnce, a separate registry
family. Static installer/uninstaller task cleanup is unchanged and is outside
this runtime migration; generic IPC remains for other operation families.

The fixed OS-absolute PowerShell provider activates only the local Task Scheduler
CLSID with in-process context. It validates the system DLL/registration, rejects
current and authenticated-caller per-user COM overrides, and pins that child
process's HKCR view to machine classes. Profiles/module autoload are disabled;
XML parsing prohibits DTDs and external resolution. No renderer chooses a COM
server, task XML/SDDL, credentials, action parameters or privileged target path.

Only supported caller-owned InteractiveToken/least-privilege tasks with one
captured native EXE action are mutable. Password/S4U/service/foreign/elevated,
known interpreter executable, COM-handler, unknown or oversized definitions are read-only with a
reason. Windows tasks are never deleted. Definition, enabled state, owner/group/
DACL, principal, EXE content and captured instance identity are rechecked around
consent and immediately before the action. Start passes null parameter overrides
and acknowledges only a native instance GUID; work completion is not assumed.
Stop addresses only the captured instance GUIDs. Deletion requires disabled,
nonrunning state and protected original definition/security evidence.

Every mutation, including start/stop/registration, has durable intent before action
and verified readback/durable completion before success. Full XML, action arguments
and security snapshots are stored under the authenticated original caller's SID
ACL, never a shared Users-readable journal. The shared cross-caller gate contains
only version, opaque ID and completion status. Uncertain outcomes retain evidence
and block further task changes; no blind retry is performed. Parent connection,
liveness and absolute expiry are checked after heavy preparation and at dispatch.

Native EXE selection issues a grant; editing its displayed path invalidates it.
New tasks and deletion recovery use create-only disabled registration with ignored
registration triggers; existing names are never overwritten. A later enable is a
separate reviewed operation. Recovery uses native originals and exact protected
poststate proofs; old caller XML/name backups are refused. Backup deletion recovery
uses a distinct native delete-only request, so a toggle/update journal cannot be
substituted. Outer backup intent saves the durable native journal ID before execute;
failed outer completion stops subsequent items. Explicit rollback may reconcile
that link only when private native evidence proves completed deletion. Uncertain
native records remain blocked. Run/stop side effects have no undo.

Owned tasks use the native executable/current caller and fixed role definitions.
Name collisions or unproven legacy tasks require manual review. Turning a role off disables future scheduling; an already-running instance is retained, and idle tasks may be removed. Status reports effective off separately from definition existence. Schedule changes
are separately journaled/confirmed disable, native disabled update and enable steps;
no silent forced replacement or name-only cleanup occurs. Runtime status uses
native metadata; errors are not reported as missing/off.

Budgets remain bounded: 64 compact rows/page, 4,096 tasks, depth 32, XML 16 KiB,
SDDL 4 KiB, full journal 28 KiB and framed data 192 KiB. Conservative journal
preflight can leave smaller complex definitions read-only. Isolated fake provider/
transaction tests and backend fixtures exercise the source without querying or
changing the host scheduler, UAC or rebooting. Live task/UAC/locale/recovery behavior
and whole-application renderer isolation remain unverified.

## Driver package migration

Driver inventory/removal now uses dedicated native inventory/prepare/execute
requests. Structured DISM metadata uses the SDK's packed driver layout with
unaligned-safe reads; SetupAPI resolves the actual source under the native
DriverStore. Opaque caller-bound grants contain metadata and a content fingerprint.
The selected package is freshly inspected through the authenticated read-only
helper before preparation. Raw INF deletion is refused. Missing or ambiguous
provider/active-use information fails closed, rather than becoming empty success.

Only supported non-inbox, non-boot-critical, unused packages receive removal
authority. Any device association or matching running system-driver basename
blocks removal. Explicit unsigned packages are refused; offline WinVerifyTrust
checks the actual held native catalog, including when DISM signature status is
unknown. This is not a claim of independent catalog-member verification. Candidate
age is a suggestion and never authorizes a change.

A separate protected driver-package directory retains the complete INF, actual
catalog and nested payload. Exact sets, sizes and SHA256 hashes must match the
source. Held ancestry/child handles and ACL checks reject reparse points,
hardlinks, traversal, case collisions and file/directory alternate streams.
Limits include 4,096 entries, 1 GiB, depth 32, deadlines, conservative names/ACLs
and a 32 KiB journal budget. Worst-case export-wrapper preflight marks oversized
manifests nonremovable before consent/export. Inventory sends compact fingerprints
and explicitly fails if its bounded response budget is exceeded.

The native helper invokes OS-absolute PnPUtil with fixed `/export-driver` and
plain `/delete-driver` arguments. No `/force`, `/uninstall` or reboot flag is
used. Complete verified backup precedes durable intent; exit zero, fresh absence
and durable completion are all required. Uncertain tool results, timeouts,
restart-required codes or unverifiable completion retain the backup/journal and
block every caller. Parent connection/liveness and the absolute deadline are
checked after heavy preparation and immediately before tool launch. Bounded
progress replies do not extend that deadline. Source pins are released just
before OS deletion; external administrator races are not atomically eliminated.

Explicit recovery requires an owned completed removal journal, reverified native
backup and fresh confirmation. `/add-driver` receives only its exact retained INF,
without `/install`, wildcards, unsigned overrides or reboot. Recovery stages the
package only; it does not reinstall devices or restore their bindings. Exact
package content must be verified afterward; an already staged exact package is a
reviewed no-op. A reused old OEM name is never deleted. Recovery consumes the
original authority; uncertain transactions are not automatically retried/restored.

Fake native engine/ABI/guard tests and scratch filesystem fixtures exercise these
paths without opening DISM, installing/removing drivers, invoking UAC or rebooting.
Live driver-store/export/removal/recovery behavior remains unverified. Generic IPC
still exists for other families; full renderer-compromise isolation is incomplete.
No new driver UI or command-line surface was added.

Interfaces follow [DISM metadata](https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/dism/dismdriverpackage-structure?view=windows-11),
[SetupAPI source resolution](https://learn.microsoft.com/en-us/windows/win32/api/setupapi/nf-setupapi-setupgetinfdriverstorelocationw)
and [PnPUtil syntax](https://learn.microsoft.com/en-us/windows-hardware/drivers/devtest/pnputil-command-syntax).

## Boot family migration

Boot callers now use a dedicated native state/prepare/execute interface. The
renderer sends only a SafeBoot mode, a timeout from 0 to 999, or a journal ID for
undo. Native code resolves the default system store, actual current-loader GUID
and boot-manager identity through the structured local `root\\WMI` BCD provider.
No localized `bcdedit` text, renderer path, loader ID, script or previous value
authorizes a write. Fixed PowerShell provider code uses the OS-absolute executable,
trusted module import, disabled autoload, bounded subprocess execution, strict
boolean method results and validated default-store object rebinding.

Caller-bound one-use plans expire after two minutes. An authenticated elevated
helper has no renderer, performs fresh identity/state checks around native consent
and parent Ready/Commit, and records protected intent before mutation. Exact
readback and durable completion precede success. Journals retain absence as well
as raw numeric values; unsupported SafeBoot and alternate-shell states are not
modified. A missing timeout means indefinite waiting. The shared machine Boot
store uses a fixed read-only Users SID solely as storage scope; authenticated
caller SIDs remain separately bound in plans and journals. A retained uncertain
head blocks every caller. Undo requires a completed, unconsumed, same-caller
journal and its exact current poststate; undo-of-undo and old renderer-only history
are refused. There is no automatic uncertain-operation resolution or rollback.

Isolated fake executor/storage/consent tests cover the transaction engine and
failure paths. Pure provider-result tests and AST parsing never open BCD. Live
provider, UAC, recovery/reboot and locale runtime checks remain unverified. This
migrates Boot callers only: generic IPC and the elevated renderer handoff still
exist for other families. Full renderer-compromise isolation is incomplete.

Provider interfaces follow [Microsoft's BCD sample](https://github.com/microsoft/Windows-classic-samples/tree/main/Samples/Win7Samples/winbase/bootconfigurationdata/bcdsamplelib)
and [BCD boot-manager element semantics](https://learn.microsoft.com/en-us/previous-versions/windows/desktop/bcd/bcdbootmgrelementtypes).

## Current Event Logs migration

The shared native operation dispatcher now contains concrete Event Logs query,
selection, preparation, execution, cancellation and acknowledgement-recovery
requests. It owns expiring channel/destination grants and one-use immutable
plans. The helper uses fixed system-tool arguments and protected native-derived
EVTX captures, records intent before mutation, and distinguishes capture from
user-file delivery. This source passed strict x64 Clippy. Isolated transaction
tests, an actual read-only inventory probe, frontend integration and disposable
Windows client VM mutation/failure checks remain pending for this snapshot.
Earlier gate results below apply only to earlier source. Generic legacy routes
remain until all callers are migrated; the complete boundary remains unfinished.

The application currently starts asInvoker. Generic IPC process commands are still
available: `run_ps`, `exec`, `run_command_line`, and `launch`. Changing the manifest
does not turn those commands into a restricted elevated broker. Recommendation 6
is therefore only partially implemented. Do not describe this application as
renderer-compromise isolated.

Implemented source slices are the five closed process actions and 136 native
Debloat catalog operations. Both use native prepare/execute plans and consent,
authenticated live helper pipes, and bounded deadlines. Debloat requests contain
only tweak ID and enabled state; the native compiled catalog resolves all paths
and typed values. Debloat serializes native mutations across caller identities,
captures authority-bound raw originals, and persists intent before each write
and verified completion afterward. Uncertain transactions prevent further writes.
None of this source has been compiled or exercised under the no-tests instruction.
Native Debloat currently retains and blocks unfinished transactions; automatic
rollback and an explicit reviewed resolution flow remain incomplete. A failed
transaction can therefore prevent both apply and restore for that tweak until
recovery is implemented and the retained evidence is reviewed.

Ordinary unelevated HKCU Debloat baselines use current-user DPAPI state. Every
helper write uses separate protected machine state, including protected HKCU
resolved through the authenticated parent SID under HKEY_USERS. User snapshots
cannot become elevated restore authority. Missing machine originals require
separate native confirmation of catalog defaults. Empty created keys remain on
restore; no query-then-delete or recursive subtree cleanup is performed. The
machine store safely refuses SYSTEM-owned leaves under its current strict policy.

Source inventory on 2026-10-29 found 165 textual invocations of the JavaScript
shell helpers (`runPS`, `runPSJson`, `reg`, `execFile`, `runCommandLine`) and 14
`sys.exec` invocations. These counts include read-only queries, wrappers, and
mutation calls; they are not 179 independently classified mutation operations.
The command used was a targeted `rg` source query, not execution of the program.

## Closed operation families

| Family and source | Read-only operations | Mutating operations to migrate |
| --- | --- | --- |
| Registry: shell, backups, transfer, debloat, ctxmenu, startup, portable, shellmenu | query, export for recovery | create/delete key; set/delete value; import bounded validated registry plan |
| Programs: programs, api, installers, winget | desktop/Appx inventory; installer/dependency/signature metadata; winget list/version/export | run registered uninstaller by fresh inventory identity; remove Appx/provisioned app; winget install/upgrade/repair |
| Services: startup, backups, monitor | enumerate/configure ownership/protection; export definition | stop/delete service; change automatic/manual/delayed state; restore recorded service definition |
| Scheduled tasks: tasks, autostart, maintenance, schedule, queue | enumerate/status/export definition | enable/disable/run/stop/delete; create least-privilege task; restore validated task definition; Purgeon-owned sign-in/maintenance task registration |
| Firewall: startup, backups | enumerate rules/application/port filters | remove rule; restore validated rule |
| Browser policies: cookierules | list current policies/rules | add/remove an exact policy list value under supported browser branches |
| Processes: processes, leftovers | sample identity/resources/running processes | terminate/suspend/resume/priority/affinity using PID + creation time and critical-status checks |
| Files: lib, backups, transfer, monitor, portableapps | stat/list/walk/hash/snapshot/size | state write/atomic write/append; checked binary copy; recycle; own-state deletion; secure erase; bounded archive extraction |
| Boot: boot | enumerate BCD/current loader | persistent safe-boot state; boot timeout with explicit persistent-change review |
| Power: power | enumerate plans/query indices | choose plan; AC/DC timeouts; bounded documented power values |
| Event logs: eventlogs | enumerate/query; export a selected log | clear selected non-Security log after successful backup; enable/disable non-Security channel |
| Health: health | disk/CIM/event/update/DISM CheckHealth/SFC verify | none for health inspection |
| System cleanup: junk, drivers | enumerate available cleanup categories/drivers | bounded known Disk Cleanup/DISM cleanup; remove selected OEM driver after backup/consent |
| Restore: restorepoint, restoremgr | list restore points/shadow storage | verified create; protection/storage changes; delete matched restore point |
| Shell launches: api, restoremgr, debloat | open OS UI/document/HTTPS URL | vendor installer launch; registered uninstaller; Explorer restart; elevation handoff |
| Settings/local state: settings, plugins, sync/history | read preferences, declarative rule metadata | serialized validated preference updates; DPAPI secret-ring changes; explicit rule approval; conflict-resolved safe preference sync |

## Required broker interface

1. The webview remains unelevated. It submits a serializable discriminated request
   containing an operation family, bounded typed arguments, inventory identity,
   expected prior-state fingerprint, recovery reference, and requested scope. No
   request may contain PowerShell source, shell command lines, arbitrary executable
   paths for privileged execution, arbitrary task XML, or unvalidated .reg text.
2. Native `prepare_operation(request)` validates all arguments and current state,
   resolves identities, and creates an immutable in-memory plan. Return an opaque
   plan ID plus human-readable exact changes, privilege requirement and recovery
   limits. Native memory owns the authoritative plan, not a renderer-supplied copy.
3. Native `execute_operation(plan_id)` rechecks freshness and consent. Operations
   requiring elevation launch a narrow helper mode via Windows UAC. The helper
   deserializes only the closed operation enum and repeats validation before
   showing native confirmation of the actual operation. It never starts a webview.
4. Bind cross-process requests to a cryptographically generated nonce and the
   immutable plan digest. Validate helper input ownership/path, size, schema,
   executable identity, and reply binding. Do not infer trust from a filename or
   an unkeyed hash supplied by the renderer. A same-user attacker modifying a
   request must not change the operation shown and approved in native consent.
5. Every mutation durably records before-state and intent before it starts, then
   completion afterward. An uncertain outcome halts the plan. Recovery requires
   state reconciliation and must not replay an entire partial operation blindly.
6. Migrate each family above before removing its old route. Once callers are
   migrated, remove generic elevated renderer endpoints. Preserve read-only
   functionality with typed native query handlers; do not call an untrusted script
   read-only based on regex matching or a renderer-provided risk label.

## Proposed migration order

First registry typed values and process identity operations; next services,
scheduled tasks, firewall and native filesystem plans; then boot/power/event logs,
restore and cleanup; finally program/package operations and the remaining queries.
Audit each family's native enum/parser/validator and caller mapping before the
next family. The entire boundary is incomplete until all generic elevated routes
are removed. No penetration, compilation, or runtime claim can be inferred from
this specification; the user has explicitly deferred validation.
