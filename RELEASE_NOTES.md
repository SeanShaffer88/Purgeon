# Purgeon 1.3.0

## New

- **Settings window** (Tools › Settings › Settings…, or `Ctrl+,`) — every Purgeon option in one window: uninstalling, appearance, window and tray, active monitoring, startup and exit, update checks, and backup limits. Changes apply at once, so several options can be set without reopening menus.
- **Active monitoring, both halves switchable** — the setup monitor (watches for installers and offers to record them) and the startup monitor (warns when a program adds itself to startup) each have their own toggle, in Settings and in the Tools menu. Turning one off never affects the other.
- **Startup and exit options** — Start with Windows, Start minimized to tray, and what the close button does (ask, keep running in the tray, or exit), all in the new Settings window.
- **Duplicate Files** (Tools › Advanced Tools) — files with identical contents under a folder you pick, grouped by exact size and confirmed by SHA-256. Nothing is ticked for you, at least one copy of each file is always kept, and removed copies go to the Recycle Bin.
- **Duplicate Programs** (Tools › Advanced Tools) — the same program installed more than once: different versions side by side, or the same version in two places. A review list; removal stays in the main program list.
- **Organization policies** — an administrator can set `DisableBatchUninstall`, `DisableForceRemove`, and `DisableSecureErase` under `HKLM\SOFTWARE\Policies\Purgeon`; the matching operations then refuse and name the policy. Policies in effect are listed in About.
- **Monitored installations remember more** — each recording keeps the installer's source path and the product, company, and version stamped in the installer file, plus your own notes for where it came from and the options chosen in it.
- **Purgeon Health** (Tools › System Tools) — a health check for Purgeon itself: settings file, data folder, removal backups, monitoring records, command log, and the update checker, each Pass / Warning / Fail with the evidence. Nothing is repaired.

## Updates

- **Download and Install** — when the opt-in update check finds a newer release, the Check for Updates dialog can now download and run the installer for you. The download runs only after its size and SHA-256 match the digest recorded for that exact release file; a mismatch deletes the download and runs nothing. Portable copies are pointed at GitHub Releases instead, as before.

## Fixes

- The update checker compared releases against version 0.0.0 because the app never reported its own version, so any release looked newer. The app now reports its real version, and the command line prints it too.

Every feature here is also on the command line: `--update install`, `--duplicates scan|remove|apps`, `--policy`, `--selfcheck`, `--monitor list` and `--monitor notes`.

Windows 10/11, x64. Unsigned, as always — no code-signing certificate.
