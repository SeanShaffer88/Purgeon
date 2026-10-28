# Purgeon 1.0.5

Purgeon helps you remove Windows programs completely and clean up what they leave behind.

## What's in this release

- **Action bar fixed after switching views.** Changing to another view and coming back no longer squeezes all the action buttons into one row with cut-off labels.
- **Name tags moved.** The small tags after a program's name (such as "unsigned" or "possible offer") now sit at the far end of the name field, away from the name itself.
- **PC specs in the status bar.** The right side of the status bar shows your Windows edition, processor and memory; hover it for the full details.
- **A safer Cleaner.** The "Large orphaned folders" category is gone — it guessed by folder name and flagged folders belonging to programs still installed. Every category the Cleaner offers is now a safe one.

## Files

- `Purgeon-Setup-x64.exe` — installer for 64-bit Windows 10 and 11
- `Purgeon-Portable-x64.zip` — portable package with the 64-bit build; extract it and run `Purgeon-Portable-x64.exe`

## Notes

- The binaries are unsigned (there is no code-signing certificate), so Windows SmartScreen may warn on first run.
- The portable build keeps its data in the `Purgeon Data` folder next to the executable.
