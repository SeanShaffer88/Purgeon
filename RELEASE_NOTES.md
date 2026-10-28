# Purgeon 1.0.9

## Change Timeline titles read in full again

On the Change Timeline, every event title lost its first letters behind the small icon at the start of its row — "Installed or updated:" read as "…stalled or updated:". A style rule for the snapshot strip in the Snapshots view happened to share its name with the Timeline view, and its wide side padding stretched the placeholder icon in every event row to twice its proper width, painting over the start of the text. The strip has its own class name now, the icon is back to its proper size, and a regression test keeps a style rule named after any list view from restyling row icons again.

## Files

- `Purgeon-Setup-x64.exe` — the installer. If Purgeon is running, it is closed for the upgrade and reopened afterwards.
- `Purgeon-Portable-x64.zip` — the portable build (the program, the license, and a short note).

Both are unsigned; Windows may show a SmartScreen prompt.
