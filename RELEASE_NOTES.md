# Purgeon 1.4.0

## New

- **The Settings window is rebuilt** — a category rail (Uninstalling, Appearance, Window & tray, Active monitoring, Startup & exit, Explorer, Backups, Prompts & trust, Updates, Data & logs) with real switches and a plain-words description for every option. Everything that used to live in the Tools › Settings submenu — the Explorer right-click toggle, Backup Settings, Confirmation Prompts, Trusted Publishers, the Command Log, Check for Updates — now lives inside the window.
- **All monitoring is off by default.** The setup monitor and the startup monitor now start off for everyone; each still has its own switch, and the installer's last screen offers a separate unticked box for each.
- **Duplicate installed entries are tagged in the program list** — when two installed entries share the same name, version and location, both get a "duplicate entry" tag explaining the fix: right-click a copy and choose Remove Entry… to delete the stale listing. The program itself is not uninstalled.
- **Old versions are tagged too** — when a newer copy of the same program is installed beside an older one, the older copy gets an "old version" tag naming the newer version.
- **Browser Clean-up shows who made each extension and what it can access** — a second line with the author (when the extension names one) and a short list of its permissions and the sites it can reach.
- **Browser Clean-up on the command line** — `Purgeon --browsers list [--json]` and `Purgeon --browsers remove <browser> <extension-id>...`, with the same rules as the window: extensions you added yourself or that a policy added are refused, and removal refuses while that browser is running.
- **Impact summary in the leftover review** — a line above the item list follows your ticks: how many files, registry entries and other items are selected, about how much space removing them will free, and a warning when the selection includes a service, scheduled task or driver.
- **Next steps under failed items** — when a removal item fails, the results list adds a plain next step matched to the failure: close the program using the file, restart Purgeon as administrator, or "already gone, nothing more to do".
- **Purgeon Health checks that things work, not just that they can be read** — it now reports the monitor states, whether the Background Monitoring and Weekly Maintenance tasks exist and match their settings (and when each last ran), and, only when update checks are on, whether the update endpoint actually answers.
- **Standard project documents** — the guides now live under `docs/` in the standard set: install, compatibility, troubleshooting, security, architecture, support and contributing alongside the feature list.

## Updates

- **Removal backups are sealed and re-checked** — every backup is fingerprinted when it is made and verified again before a restore. A backup whose contents changed, or whose record is damaged, is refused with a plain explanation instead of being trusted.
- **Interrupted removals are recovered or held for review** — if Purgeon stops mid-removal, the next start either rolls the removal back or keeps the backup clearly marked as needing review. Nothing is silently dropped.
- **One gatekeeper for administrator work** — privileged actions are planned and checked in one place before anything runs, and the confirmation prompt describes that plan in plain words before you approve it.
- **A hardier window** — long lists render in pages as you scroll, dialogs load only when opened, and if a view ever fails, Purgeon shows a readable error screen with a reload button instead of going blank.

The headline features are on the command line too: `--browsers list|remove`, `--selfcheck`, `--duplicates apps`, plus the new `--setup-monitor on|off` and `--startup-monitor on|off`.

Windows 10/11, x64. Unsigned, as always — no code-signing certificate.
