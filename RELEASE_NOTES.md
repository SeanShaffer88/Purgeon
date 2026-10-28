# Purgeon 1.0.8

## Disk Usage works now

On real PCs, Disk Usage opened to "No drives found" and never scanned anything: the question it asks Windows for the drive list was missing a piece, the answer could not be read, and the failure stayed silent. The drive list now comes from the system's own drive information (with the repaired question as a fallback), and opening the view scans your system drive straight away, biggest folders and files first.

## Slimmer menus

The menu bar's long lists are grouped into flyouts: File gains Move & Sync; Action gains Repair, Program, and Open; View gains Go to, Zoom, Appearance, Window, and Background (the program filters and recent programs have their own groups too); Tools gains Records, Find & Fix, Lists & Portable, and Settings. No command was removed — the command palette still finds every one of them — and the arrow keys move into and out of a flyout.

## Reliability fixes from a full audit

- A removal interrupted at exactly the wrong moment (a crash or power cut while its record was being written) left a damaged record that was silently ignored — the interrupted removal never reappeared and could never be cleared. It is now reported, explains itself, and can be cleared.
- Two settings changes made at the same moment could silently undo each other; settings writes now take turns.
- A typed group name could impersonate a built-in group in the filter; that is no longer possible.
- Disk Usage no longer lists drives that report no space at all, such as an empty card reader.
- The `--help` text now lists the `--sync`, `--portableapps`, and `--export` commands, which worked but were undocumented.

## Under the hood

Leftover code and styles from features that no longer exist were removed (about 19 KB of source), which slightly shrinks the built program. Nothing about how Purgeon works changed with this tidy-up.

## Files

- `Purgeon-Setup-x64.exe` — the installer. If Purgeon is running, it is closed for the upgrade and reopened afterwards.
- `Purgeon-Portable-x64.zip` — the portable build (the program, the license, and a short note).

Both are unsigned; Windows may show a SmartScreen prompt.
