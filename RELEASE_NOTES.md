# Purgeon 1.0.4

Purgeon helps you remove Windows programs completely and clean up what they leave behind.

## What's in this release

- **64-bit only.** This release ships exactly two files (below) for 64-bit Windows 10 and 11. The 32-bit build, the universal installer and the MSI from earlier releases are discontinued.
- **Faster repeat starts and refreshes.** Program signature and architecture results, and program icons, are remembered per program file and only recomputed when that file changes — refreshing the program list no longer re-checks every program from scratch.
- **Smoother launch.** Background measuring starts after the window paints, and measured sizes reach the list in small batches instead of one update per program.
- Settings are read once and kept in step with the settings file, and the command log is flushed before exit.

## Files

- `Purgeon-Setup-x64.exe` — installer for 64-bit Windows 10 and 11
- `Purgeon-Portable-x64.zip` — portable package with the 64-bit build; extract it and run `Purgeon-Portable-x64.exe`

## Notes

- The binaries are unsigned (there is no code-signing certificate), so Windows SmartScreen may warn on first run.
- The portable build keeps its data in the `Purgeon Data` folder next to the executable.
