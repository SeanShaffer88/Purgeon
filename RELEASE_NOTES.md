# Purgeon 1.0.10

## Advanced Tools

Five new tools live under **Tools › Advanced Tools** — powerful, kept out of the main window, each in its own window:

- **Recovery Packages** — every removal backup, with proof it can be restored. New backups are verified as they are made (seal check, a trial restore of the stored exports, a Recycle Bin presence check), and single items can be ticked and restored out of a package instead of everything.
- **Shared Components** — the shared runtimes, shared install folders and shared files Purgeon refuses to delete during a removal, with the programs that depend on each folder. For shared files, Windows records how many programs use each one but not which — the window says so rather than guessing.
- **Secure Erase** — overwrites files (1 pass of zeros, 1 pass of random data, or 3 passes) and then deletes them so they cannot be undeleted. Files only; links and protected Windows locations are refused. No backup and no undo, by design: the list is reviewed and confirmed every time, and the window states the honest SSD limit.
- **Games** — the games Steam, Epic and GOG report, with folder sizes and a total, plus a Games group in the main list. Uninstalling stays with the launcher; a game whose files are already gone can have its leftover entry cleaned up through the standard backed-up removal.
- **Relationship Graph** — how each program connects to the rest of the system: its services, tasks and startup entries, what depends on it, and its shared files, joined entirely on your PC. Orphaned entries (pointing at files that no longer exist) are listed first; orphaned services and tasks can be removed there, backed up first.

## Also in this release

- Every file Purgeon uses to remember things is now written atomically — a crash or power cut mid-write cannot leave a damaged file behind. If a settings, groups or Debloat data file is ever found damaged, the damaged copy is kept beside the original and the app tells you, instead of silently resetting it.
- Snapshots can be cancelled while being taken or compared.
- The Apps view shows each app's size, measured from its own package folder.
- New command-line commands: `--timeline`, `--history`, `--archive` (with `--json`), matching their windows.
- Timeline row tooltips now include the event's detail text.
