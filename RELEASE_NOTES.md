# Purgeon 1.2.0

## New: System Tools

- **Processes view** — live processor, memory and disk meters with rolling graphs; per-process use and priority; End, Suspend and Resume; priority and processor-core changes. Windows' critical processes and Purgeon itself are protected. Changes are recorded in Change History, with undo where one exists.
- **Resource alerts** — while Purgeon runs (tray included), it warns once per condition when processor or memory stays over a level you set, or the system disk runs low.
- **Performance debloat section** — 7 switches, each checked against Microsoft documentation first (Game Mode, GPU scheduling, power throttling off, background Store apps off, visual effects for performance, and more). Debloat now totals 136 tweaks in 9 groups.
- **Power Options window** — power plans, screen/sleep/hibernate timings, battery-saver level, wake timers and USB power-down, all through Windows' own powercfg, each change recorded with an undo.
- **System Restore window** — restore storage per drive (view and resize), protection on/off, create and delete individual points (only when a point matches its stored copy exactly), and a button for Windows' own roll-back wizard.
- **Boot Options window** — choose the next start (Normal, Safe Mode, Safe Mode with networking) with a restore point offered first and a second confirmation; boot-menu wait time; the Windows versions on the PC, read-only.
- **Event Logs window** — every Windows log with counts and sizes, searchable; save any log to a file; clearing a log always saves a copy first. The Security log is view-and-save only.
- **Health Check window** — a plain-words once-over (drive health and space, system-file check, recent restore point, waiting updates, recent crashes, startup load, battery wear), each line Pass / Warning / Fail / Couldn't check with the reason, nothing repaired automatically, cancellable, report can be saved, and it can join the existing Weekly Maintenance run.
- **Scheduled Tasks window** — all scheduled tasks including Windows' own (badged, never deletable here); run, stop, turn off/on; deleting a task saves its definition first so Change History can undo it; create simple tasks.
- **Cookie rules per site** — Blocked and Allowed site lists for Chrome and Edge, written to the browsers' own policy keys so they hold in every profile. Firefox is not covered and the window says so plainly.

## Fixes

- Startup trust warnings never appeared (the check's module was never loaded and failed silently) — they now flag entries running from Temp/Downloads, unsigned entries, and newly appeared ones.
- Scheduled background monitoring failed at the end of every run while recording its results — scans now finish and are recorded.
- Settings sync forgot its folder and on/off choice at every restart — both are saved now.
- A backup id of "." pointed at the whole backups folder and passed the safety check — refused now, and restores check ids the same way deletes do.
- Encrypted backup manifests over about 125 KB could not be written, which could have stopped a large removal partway through — fixed.

x64 only. Unsigned, as always.
