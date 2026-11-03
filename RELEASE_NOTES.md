# Purgeon 1.4.2

## Recovery and Update Fixes

- Program-restore undo validates the complete journal, every target and saved registry export before changing anything. Registry failures stay failures; ambiguous or incomplete recovery records are retained for manual review.
- Purgeon updates use a fresh native download reservation. Native code hashes the held installer file and pins its identity and ancestor paths through synchronous process creation, using the checked machine executable elevation class. This guarantee ends at process creation; it does not certify installer lifetime or later extracted payloads. Expected release metadata still comes from the application's GitHub response.
- Settings, uninstall queues and trial records distinguish missing files from read failures. Damaged settings are replaced only after a saved copy is verified. Invalid queue/trial records require recovery. Ending a trial saves the updated list before snapshot cleanup.

## Native Operation Boundaries

- DNS status handles singleton responses and reports encrypted lookup mode only when all configured IPv4 servers match. Changes check encryption capabilities and shared global registrations before switching DNS, verify readback, and report incomplete synchronous rollback. Nagle changes verify writes and restore prior value types or absence on failure.
- Boot changes use closed native requests, exact loader identity checks and protected journal-bound undo, including restoration of an originally absent setting.
- Driver removal checks native package identity and active use, keeps a complete verified protected backup, and uses plain removal without forced device uninstall. Explicit recovery stages the verified package only; it does not reinstall devices or bind drivers.
- Supported scheduled-task actions use caller-bound native identities and private recovery records. Unsupported tasks remain read-only. Creation and deletion recovery register tasks disabled without overwriting a replacement; legacy caller XML recovery is refused. Startup, deeper scans, backups and Purgeon's owned schedules use this boundary.

## Scope and Validation Limits

Known audit findings remain open: non-task backup checkpoint failures can permit later operations; legacy text writes/appends do not reject hardlinks; Boot's final probe can outlive its plan deadline; secure erase can use a stale pre-open length; command logs can contain sensitive arguments; cookie-policy paths can resolve outside the registry; and a power-timeout request can apply its AC value before rejecting an invalid DC value. This release does not fix those deferred items.

Windows 10/11, x64. Both the built application and Setup program are unsigned (Authenticode: NotSigned); no signing credentials were configured.

Automated checks use fake system adapters and neutral scratch fixtures. No live installer, UAC, Boot, driver, Task Scheduler or DNS mutation was used for local validation, and no disposable-VM installation or runtime OS-matrix qualification was performed. Live compatibility and recovery behavior remain unverified. Other operation families still use generic IPC, so full renderer isolation and a whole-product security certification are not claimed.

Download either **Purgeon-Setup-x64.exe** or **Purgeon-Portable-x64.zip**. The portable ZIP contains **Purgeon-Portable-x64.exe**, **LICENSE** and **PORTABLE.txt**.
