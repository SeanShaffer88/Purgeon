# Purgeon 1.0.7

Purgeon helps you remove Windows programs completely and clean up what they leave behind.

## What's in this release

- **New Disk Usage view.** See what is using the space on each drive, biggest first, and open folders to drill down — each item shows its size and its share of the folder it sits in. Links are listed but never counted, so nothing is double-counted, a folder whose counting stopped early is marked "at least", and the scan can be cancelled and keeps what it measured. Also available on the command line as `--disk`.
- **The Apps view is now a full inventory.** Framework and system components are listed too, tagged "system component" and shown locked — never offered for removal — and the header counts them. Known pre-installed apps carry a short plain-words note about what they are. Apps with a provisioned copy (the copy Windows gives to new user accounts) are tagged, and removing one offers to remove the provisioned copy too. Removed Store apps can be brought back from the Uninstall Archive: Purgeon re-registers a copy still on the PC, or opens the app's Microsoft Store page when none remains.
- **Built-in groups.** The group picker now leads with groups computed live from your programs: Bundled software (possible offers), Installed together, Unsigned, Bad signature, Growing in size, Large programs (1 GB or more), Recently installed (30 days), Microsoft, and No publisher listed.
- **Every long task can be cancelled, and deletes go to the Recycle Bin.** Removing items with backup, the Windows clean-ups, and the Disk Map sweep now stop when you press Cancel, report anything not done as left in place, and keep what was already removed fully undoable. Deleting a backup or a snapshot sends it to the Recycle Bin instead of erasing it. This release also fixes the report that could fail to appear after a Windows clean-up run.
- **Lighter running.** The Debloat, Startup & Services, Cleaner and Disk Usage screens load only when first opened, so the window paints sooner, and the installer watch backs off from every 3 seconds to every 10 while Purgeon is hidden or in the tray.
- **Removed: the What's This page.** Its "what it hooks into Windows" list still appears inside Analyze Program, keeping everything in one place.

## Files

- `Purgeon-Setup-x64.exe` — installer for 64-bit Windows 10 and 11
- `Purgeon-Portable-x64.zip` — portable package with the 64-bit build; extract it and run `Purgeon-Portable-x64.exe`

## Notes

- The binaries are unsigned (there is no code-signing certificate), so Windows SmartScreen may warn on first run.
- The portable build keeps its data in the `Purgeon Data` folder next to the executable.
