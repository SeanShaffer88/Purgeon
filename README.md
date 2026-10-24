# SweepUninstall

A Windows uninstaller that removes a program and then finds the files, folders, registry keys, startup entries and services it left behind.
It can monitor installations, take snapshots of your system to compare before and after, clean junk files, and manage startup programs and services. Every change is backed up first and can be undone.

It has a compact single-list window with a dark terminal theme. It is built with [Tauri](https://tauri.app/) and React on Windows' built-in WebView2, so the whole app is a **3.7 MB** exe in a **1.2 MB** installer.

![SweepUninstall main window](docs/screenshots/main.png)

## Features

**Program list**
- Two even toolbars sit under the menu bar:
  - the top one switches between Desktop Programs and Windows Store Apps, opens **Debloat Windows** and **Startup & Services**, and has the search box;
  - the second opens **Monitored Programs**, **Snapshots** and **Junk Files**, and picks a program group.
- Clicking an active button again returns to the program list. **Backups** and **Change History** are in the Tools menu.
- Desktop programs from all three registry uninstall locations (64-bit, 32-bit and per-user), with icons, size and install date
- When a program doesn't report its size or install date, SweepUninstall measures its folder in the background. Measured values are shown in italics; hover one to see which folder it came from.
- Windows Store apps
- Sort by any column, instant search, and type-to-jump
- Programs installed only for the current user are shown in amber

**Program groups**
- Right-click a program (or several) and choose **Set Group** (Ctrl+G) to file it under a name such as Games, Work or Media. The group shows as a tag next to the program's name.
- The group list in the second toolbar shows one group at a time, or only the programs that have no group. Searching also matches group names.
- Group changes are recorded in Change History and can be undone.

**Uninstall and leftover cleanup**
- Runs the program's own uninstaller, then waits for it to finish. This includes Inno Setup and NSIS uninstallers that relaunch themselves from `%TEMP%`.
- Scans for leftovers:
  - the install folder
  - folders named after the program or its publisher in Program Files, ProgramData and AppData
  - Start Menu and desktop shortcuts that point into the install folder
  - `Software` registry keys
  - App Paths registrations
  - startup Run entries
  - services
  - scheduled tasks that run the program or are named after it
  - firewall rules for the program's executables
  - Explorer right-click entries and shell extensions
  - file types, URL handlers and "Open with" registrations
  - data and cache folders named after the program's own executables
- Every item gets a **match score** from 0 to 100%. Items scoring 70% or more start ticked; weaker guesses start unticked and are marked **check**.
- Publisher folders count only when named exactly after the publisher, so removing Google Chrome never offers another Google product's folders.
- **Force Removal** handles programs whose uninstaller is broken or missing.
- **Analyze Leftovers** shows what belongs to a program without uninstalling it.
- Running processes in the install folder are detected and can be closed before deleting.

**Batch uninstall**
- Select several programs with `Ctrl+click`, `Shift+click`, `Shift+arrows` or `Ctrl+A`, then press `Del` or choose **Uninstall N Programs** from the right-click menu. This works for desktop programs and Store apps.
- Each program's own uninstaller runs in turn. **Stop After This One** cancels the rest of the batch once the current uninstaller finishes.
- Afterwards, one combined leftover list shows every program's files, folders, registry entries and services, grouped by program, with one **Delete Selected**.
- The summary reports any uninstaller that failed or was cancelled, and any program that was skipped.

**Restore points**
- Before an uninstall, a batch, a force removal, or your first Debloat change in a session, the confirmation offers **Create a restore point first** (ticked by default).
- Creating a restore point needs administrator rights and System Protection turned on. Windows may also skip it if one was made in the last 24 hours. If no point is made, SweepUninstall shows a warning and continues.
- **Tools › Create Restore Points** sets whether the checkbox starts ticked.

**Installation monitor**
- **Tools › Monitor an Installation** takes a snapshot of the file system and registry, runs your installer, takes a second snapshot and records every folder, file, registry key, registry value and service that was added.
- It also records existing settings the installer changed, such as a file association or a Run entry it replaced. Uninstalling the program puts those settings back to what they were before.
- Monitored programs appear under the **Monitored Programs** button (or `Ctrl+3`). Uninstalling one removes exactly what its installation created.

**Snapshots**
- **Snapshots** (`Ctrl+7`) keeps named records of your files, folders and registry settings: Program Files, ProgramData, AppData, the Start Menu and desktops, plus the software and services parts of the registry. Temporary files and caches are left out.
- Take one before installing or changing something, in three depths: **Quick** (a few seconds), **Standard** and **Deep**.
- **Compare with Now** or **Compare Selected** (two snapshots) shows what was **added**, **removed** and **changed**, with old and new registry values side by side. You can filter by files or registry and search the results.
- **Clean Up Selected** removes added items and puts changed or removed registry values and keys back from the earlier snapshot. Everything is backed up first and can be undone.
- Comparisons can be exported to HTML.

**Junk Files**
- **Junk Files** (`Ctrl+8`) finds files that Windows and programs recreate when needed, with their sizes:
  - temporary files (yours and Windows'), keeping anything used in the last day
  - crash dumps and Windows error reports
  - the Explorer thumbnail cache and DirectX shader caches
  - downloaded Windows Update files and the Delivery Optimization cache
- Tick the categories to clean and click **Clean**. Expand a category to see its largest items.
- Cleaned items go to the Recycle Bin, so a cleanup can be undone from Change History. Files in use are skipped. The registry is never touched.

**Debloat Windows**
- The **Debloat Windows** button next to the view picker (or `Ctrl+5`) lists 26 safe, reversible tweaks in five groups: Privacy & telemetry, Start/search/taskbar, Ads & suggestions, Explorer & UI, and Windows Update.
- Each option is either **ENABLED** (green, the tweak is applied) or **DISABLED** (red, Windows default). Click an option to toggle it. Turning one off puts back exactly the value you had before SweepUninstall applied it (or Windows' default if it never changed it).
- Each option says when it takes effect: **Applies immediately**, **Needs Explorer restart** or **Needs reboot**. A **Restart Explorer** button appears when an Explorer change is pending.
- Machine-wide policies are tagged **Admin** and need SweepUninstall to run as administrator.
- Only options that are safe and widely recommended are included: no service removal, no app removal, and no security features turned off.

**Startup & Services**
- The **Startup & Services** button in the second toolbar (or `Ctrl+6`) lists everything that starts with Windows:
  - Run entries and Startup-folder shortcuts
  - scheduled tasks outside Windows' own `\Microsoft\` folder
  - third-party services that start automatically, but only ones that can actually be changed (Windows-protected services, and services that lock their own settings, are not listed)
- Each entry shows **ENABLED** (green) or **DISABLED** (red), its publisher, its command, and which installed program it belongs to. Click to toggle.
- Turning an entry off never deletes it:
  - Run entries and shortcuts use Windows' own on/off switch, the same one Task Manager's Startup tab uses.
  - Tasks are disabled.
  - Services are switched from Automatic to Manual. They no longer start at boot but can still start when needed. Their original start mode is remembered and restored when you turn them back on.
- Entries from Microsoft are tagged **Windows** and ask before being turned off. Each entry says when a change applies: **Next sign-in** or **Next restart**.

**Backups and restore**
- Before anything is deleted, it is backed up:
  - Registry keys are exported to `.reg` files, and registry values are recorded with their type and data.
  - Scheduled tasks are exported to XML.
  - Firewall rules are saved with their settings.
  - Services have their definition exported.
  - Files go to the Recycle Bin.
  - Registry values a cleanup puts back have their current value recorded first.
- **Tools › Backups** (`Ctrl+4`) restores any removal: registry entries, tasks, firewall rules, services, and files, which are moved back out of the Recycle Bin automatically.

**Change History and undo**
- **Tools › Change History** (`Ctrl+H`) lists every change SweepUninstall makes: removals and cleanups, debloat tweaks, startup and service changes, group changes, snapshots, uninstalls, restores and restore points.
- Double-click a change (or press `Del`) to undo it. Undone changes stay listed and are marked **(undone)**.
- After a removal, the report has an **Undo** button that puts everything back at once.
- An uninstaller run can't be undone directly; reinstall the program or use the restore point made before it.

**Safety**
- An automated test suite runs on every build and blocks a release if it fails. It covers name matching, the protected-folder guard, snapshot comparison, debloat reversibility, match scores and the startup switches.
- SweepUninstall never offers drive roots, relative paths, the Windows folder, your profile folder, install roots, or folders with generic names such as `Microsoft` or `Common Files`.
- It refuses to delete registry keys that Windows depends on (hive roots, `HKLM\SYSTEM`, Windows' own keys under `SOFTWARE\Microsoft`, file-extension keys and shared shell keys), even when told to.
- It never deletes Windows' own services (protected ones, or ones whose program is in the Windows folder) or scheduled tasks under `\Microsoft\`.
- Only services whose settings can actually be changed are offered in Startup & Services.
- Junk cleaning only ever touches the contents of the known junk folders listed above, never the folders themselves or anything outside them.

**Display**
- The window opens at a size that fits your screen, and very large screens get a little extra zoom automatically. Windows' display scale setting is respected.
- `Ctrl++` / `Ctrl+-` / `Ctrl+0` (or View › Zoom) change the zoom; your choice is remembered.

**Also**
- Remove a stale uninstall entry
- Open a program's key in Regedit or open its install folder
- Search for a program online
- Show properties, including the uninstall command and registry key
- Export the list to HTML

## Screenshots

| Leftover scan | Context menu |
| --- | --- |
| ![Leftover scan](docs/screenshots/leftovers.png) | ![Context menu](docs/screenshots/context-menu.png) |

| Multi-select | Batch uninstall leftovers |
| --- | --- |
| ![Three programs selected](docs/screenshots/multi-select.png) | ![Combined leftover list after a batch uninstall](docs/screenshots/batch-uninstall.png) |

| Startup & Services | Monitored Programs |
| --- | --- |
| ![Startup and services manager](docs/screenshots/startup.png) | ![Monitored programs](docs/screenshots/monitored.png) |

| Installation monitor | Windows Store apps |
| --- | --- |
| ![Installation monitor](docs/screenshots/monitor.png) | ![Windows Store apps](docs/screenshots/store-apps.png) |

| Snapshots | Snapshot comparison |
| --- | --- |
| ![Saved snapshots](docs/screenshots/snapshots.png) | ![Comparing a snapshot with the system now](docs/screenshots/snapshot-compare.png) |

| Junk Files | Program groups |
| --- | --- |
| ![Junk files by category](docs/screenshots/junk.png) | ![Program list filtered to one group](docs/screenshots/groups.png) |

| Debloat Windows | Debloat Windows (Explorer and Windows Update) |
| --- | --- |
| ![Debloat Windows, privacy and taskbar tweaks](docs/screenshots/debloat-top.png) | ![Debloat Windows, Explorer and Windows Update tweaks](docs/screenshots/debloat-bottom.png) |

Screenshots use demo data.

## Download

Get the latest version from [Releases](https://github.com/SeanShaffer88/SweepUninstall/releases/latest). It runs on Windows 10 and 11 (64-bit).

- **`SweepUninstall-Setup-<version>.exe`** (about 1.2 MB) installs for all users, with a Start Menu shortcut. You can remove it later from Settings › Apps.
- **`SweepUninstall-Portable-<version>.exe`** (about 3.7 MB) is the whole app as one exe that runs without installing. It keeps its settings, backups, snapshots and browser data in a `SweepUninstall Data` folder next to the exe, so you can carry it on a USB drive. Any copy whose file name contains `portable`, or that has a file named `portable` next to it, works this way.

Both ask for administrator rights when they start, because removing programs installed for all users, creating restore points and machine-wide debloat tweaks all need them.

SweepUninstall uses the Microsoft Edge WebView2 runtime, which is part of Windows 10 and 11. If it's missing, the installer downloads it.

**Lightweight:** while idle, SweepUninstall uses about 125–135 MB of private memory, counting all of WebView2's helper processes. GPU acceleration is turned off because a list window doesn't need it. Before version 0.4.0, SweepUninstall was built on Electron: a 357 MB install folder, a 116 MB installer, and about 250 MB of memory.

The exes are not code-signed yet, so Windows SmartScreen may show "Windows protected your PC". Click **More info › Run anyway** to start it.

## Run from source

Requirements: Windows 10 or 11, [Node.js](https://nodejs.org/) 20 or later, and [Rust](https://rustup.rs/) (stable).

```bash
git clone https://github.com/SeanShaffer88/SweepUninstall.git
cd SweepUninstall
npm install
npm run dev
```

`npm run dev` starts Vite and the app with live reload. Like the released app, it asks for administrator rights when it starts.

### Build the installer

```bash
npm run dist
```

The app exe is written to `src-tauri/target/release/sweepuninstall.exe`, and the installer to `src-tauri/target/release/bundle/nsis/`.

Pushing a tag like `v0.4.0` makes GitHub Actions run the tests, build the installer and the portable exe, and publish both as a GitHub Release.

## Command line

Snapshots can be taken and compared from a terminal, for scripts or scheduled checks. Nothing is shown on screen.

```bash
SweepUninstall --snapshot "Before installing X" --preset quick
SweepUninstall --compare "Before installing X" now --report changes.html
SweepUninstall --list-snapshots
SweepUninstall --help
```

- `--preset` is `quick`, `standard` (the default) or `deep`.
- A snapshot is named by its id, its name, or `latest`. Compare two snapshots, or one with `now`.
- `--report` saves the comparison as HTML, JSON or plain text, depending on the file extension.
- The exit code is 0 on success and 1 on an error. Because SweepUninstall asks for administrator rights, run it from an administrator terminal to see its output there.

### Run the tests

```bash
npm test
```

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Del` | Uninstall (all selected programs when several are selected) |
| `Ctrl+click` / `Shift+click` / `Shift+arrows` | Select several programs |
| `Ctrl+A` | Select all listed programs |
| `Shift+Del` | Force removal |
| `Ctrl+L` | Analyze leftovers |
| `Alt+Enter` / `Enter` | Properties |
| `Ctrl+F` | Search |
| `Ctrl+1` / `Ctrl+2` | Desktop programs / Windows Store apps |
| `Ctrl+3` | Monitored programs |
| `Ctrl+4` | Backups |
| `Ctrl+5` | Debloat Windows |
| `Ctrl+6` | Startup & Services |
| `Ctrl+7` | Snapshots |
| `Ctrl+8` | Junk Files |
| `Ctrl+G` | Set group for the selected programs |
| `Ctrl+M` | Monitor an installation |
| `Ctrl+H` | Change History |
| `Ctrl++` / `Ctrl+-` / `Ctrl+0` | Zoom in / out / reset |
| `Ctrl+S` | Export to HTML |
| `F5` | Refresh |

## How it works

| File | Role |
| --- | --- |
| `src-tauri/src/lib.rs` | Small Rust core: runs PowerShell and system tools, reads folders, measures sizes, lists junk folders, moves files to the Recycle Bin, portable mode and command-line output |
| `src-tauri/src/snapshot.rs` | Snapshot engine: records files, folders, registry keys and values into a compressed file, and compares two snapshots |
| `src/backend/programs.js` | Reads the Uninstall registry keys and `Get-AppxPackage`; extracts program icons |
| `src/backend/leftovers.js` | Leftover scan of folders, shortcuts and registry, plus match scoring |
| `src/backend/deepscan.js` | Scheduled tasks, firewall rules, shell extensions, file types and exe-named data folders |
| `src/backend/measure.js` | Measures missing sizes and install dates from program folders |
| `src/backend/startup.js` | Startup & Services: lists entries and turns them on or off without deleting them |
| `src/backend/monitor.js` | Installation monitor: snapshots before and after an installer, turned into what to remove and what to put back |
| `src/backend/snapshots.js` | Named snapshots, comparisons and cleanup of their differences |
| `src/backend/junk.js` | Junk file categories, scanning and the junk-folder guard |
| `src/backend/groups.js` | Program groups |
| `src/backend/history.js` | Change History and the request that undoes each change |
| `src/cli.js` | Command-line snapshot and compare |
| `src/backend/backups.js` | Backup (`reg export`, value capture, task and firewall export, Recycle Bin), removal and restore |
| `src/backend/debloat.js` | Debloat tweak catalog: reads, applies and reverts registry values |
| `src/backend/restore.js` | Creates System Restore points with `Checkpoint-Computer` and explains why Windows skipped one |
| `src/backend/paths.js` | Well-known install roots, plus guards that refuse to touch system folders |
| `src/backend/api.js` | Answers the UI's requests by calling the modules above |
| `src/*.jsx` | React UI |
| `test/` | Safety tests (`node --test`), run against the same backend code through a Node.js version of the system layer |

## Limitations

- Snapshots and the installation monitor record files and registry keys to a fixed depth (six levels for Standard, ten for Deep) under the usual install roots and the `Software` registry branches. A change below that depth is not captured. File contents are not stored, so changed or removed files are listed but can't be put back.
- Changes made by other programs while monitoring is active, or between two snapshots, are listed too. Review the list before cleaning up.
- Files can be restored only while they are still in the Recycle Bin. Junk files moved there still take space until it is emptied. A restored service comes back after a restart.
- Measured sizes stop after 15 seconds or 300,000 files per folder. A "+" after the size means it is at least that large.

## Disclaimer

SweepUninstall is an independent project, written from scratch using documented Windows APIs.
It is not affiliated with any other uninstaller and contains no code from one.
Uninstalling software changes your system, so review what is selected before deleting.

## License

[MIT](LICENSE)
