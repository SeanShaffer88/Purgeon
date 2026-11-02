# How Purgeon is put together

Purgeon is a Windows program built with Tauri 2 and React. The window is a
web page shown by Windows' built-in WebView2; everything else is plain
JavaScript and a small Rust shell.

## The three layers

- **Window (React, `src/`)** — the program list, dialogs and pages. The
  window never changes Windows itself; it asks for an operation and shows
  the result.
- **Operations (`src/backend/`)** — every job Purgeon can do (scan, plan,
  remove, back up, restore, clean, monitor) is a named operation in the
  backend. The window, the command line (`src/cli.js`) and scheduled
  background runs all call the same operations, so a job behaves the same
  however it is started.
- **Windows boundary** — changes to Windows go through one guarded
  PowerShell runner or a small set of Rust helpers in `src-tauri/`
  (registry reads, event tracing, file hashing). Nothing else in the app
  talks to the system directly.

## Safety model

Every change follows the same order: **preview → backup → apply → check**.
Removals, leftover clean-ups and tweaks write a backup first, and the
Backups page can undo them. Before big jobs Purgeon offers a Windows
restore point. If a step fails, the results list says what happened and
what to try next.

## Where the data lives

Settings, backups, snapshots, restore data and monitor records live in
Purgeon's own data folder (the portable copy keeps a `data` folder beside
the program). Files are written atomically — written to a spare name and
then swapped in — so a crash mid-save cannot corrupt the last good copy.
Settings carry a version number and are upgraded in place when the format
changes.

## Background work

Two optional monitors (off unless switched on in Settings) watch for new
installers and new startup entries. They run through a scheduled task and
the same operations as the window, and Purgeon Health checks that the
tasks and settings agree with each other.
