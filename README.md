# SweepUninstall

A Windows uninstaller that removes a program and then finds the files, folders, registry keys, startup entries and services it left behind.
You can also monitor an installation to record exactly what it changes, and every removal is backed up first.

It has a compact single-list window with a dark terminal theme. It is built with [Tauri](https://tauri.app/) and React on Windows' built-in WebView2, so the whole app is a **3.3 MB** exe in a **1.2 MB** installer.

![SweepUninstall main window](docs/screenshots/main.png)

## Features

**Program list**
- Desktop programs from all three registry uninstall locations (64-bit, 32-bit and per-user), with icons, size and install date
- When a program doesn't report its size or install date, SweepUninstall measures its folder in the background. Measured values are shown in italics; hover one to see which folder it came from.
- Windows Store apps
- Sort by any column, instant search, and type-to-jump
- Programs installed only for the current user are shown in amber

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
- **Tools › Monitor an Installation** takes a snapshot of the file system and registry, runs your installer, takes a second snapshot and records every folder, file, registry key, startup entry and service that was added.
- Monitored programs appear under **View › Monitored Programs**. Uninstalling one removes exactly what its installation created.

**Debloat Windows**
- The **Debloat Windows** button next to the view picker (or `Ctrl+5`) lists 26 safe, reversible tweaks in five groups: Privacy & telemetry, Start/search/taskbar, Ads & suggestions, Explorer & UI, and Windows Update.
- Each option is either **ENABLED** (green, the tweak is applied) or **DISABLED** (red, Windows default). Click an option to toggle it. Turning one off restores the Windows default.
- Each option says when it takes effect: **Applies immediately**, **Needs Explorer restart** or **Needs reboot**. A **Restart Explorer** button appears when an Explorer change is pending.
- Machine-wide policies are tagged **Admin** and need SweepUninstall to run as administrator.
- Only options that are safe and widely recommended are included: no service removal, no app removal, and no security features turned off.

**Startup & Services**
- **View › Startup & Services** (`Ctrl+6`) lists everything that starts with Windows:
  - Run entries and Startup-folder shortcuts
  - scheduled tasks outside Windows' own `\Microsoft\` folder
  - third-party services that start automatically
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
- **View › Backups** restores registry entries, tasks, firewall rules and services from any removal.

**Safety**
- An automated test suite runs on every build and blocks a release if it fails. It covers name matching, the protected-folder guard, snapshot comparison, debloat reversibility, match scores and the startup switches.
- SweepUninstall never offers drive roots, relative paths, the Windows folder, your profile folder, install roots, or folders with generic names such as `Microsoft` or `Common Files`.

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

| Startup & Services |
| --- |
| ![Startup and services manager](docs/screenshots/startup.png) |

| Installation monitor | Windows Store apps |
| --- | --- |
| ![Installation monitor](docs/screenshots/monitor.png) | ![Windows Store apps](docs/screenshots/store-apps.png) |

| Debloat Windows | Debloat Windows (Explorer and Windows Update) |
| --- | --- |
| ![Debloat Windows, privacy and taskbar tweaks](docs/screenshots/debloat-top.png) | ![Debloat Windows, Explorer and Windows Update tweaks](docs/screenshots/debloat-bottom.png) |

Screenshots use demo data.

## Download

Get the latest version from [Releases](https://github.com/SeanShaffer88/SweepUninstall/releases/latest). It runs on Windows 10 and 11 (64-bit).

- **`SweepUninstall-Setup-<version>.exe`** (about 1.2 MB) installs for all users, with a Start Menu shortcut. You can remove it later from Settings › Apps.
- **`SweepUninstall-Portable-<version>.exe`** (about 3.3 MB) is the whole app as one exe that runs without installing.
- **`SweepUninstall-Portable-<version>-win-x64.zip`** is the same portable exe, zipped.

All of them ask for administrator rights when they start, because removing programs installed for all users, creating restore points and machine-wide debloat tweaks all need them.

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

Pushing a tag like `v0.4.0` makes GitHub Actions run the tests, build the installer, the portable exe and the zip, and publish them as a GitHub Release.

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
| `Ctrl+1` to `Ctrl+4` | Desktop programs, Store apps, Monitored programs, Backups |
| `Ctrl+5` | Debloat Windows |
| `Ctrl+6` | Startup & Services |
| `Ctrl+M` | Monitor an installation |
| `Ctrl+S` | Export to HTML |
| `F5` | Refresh |

## How it works

| File | Role |
| --- | --- |
| `src-tauri/src/lib.rs` | Small Rust core: runs PowerShell and system tools, reads folders, measures sizes, walks snapshots, moves files to the Recycle Bin |
| `src/backend/programs.js` | Reads the Uninstall registry keys and `Get-AppxPackage`; extracts program icons |
| `src/backend/leftovers.js` | Leftover scan of folders, shortcuts and registry, plus match scoring |
| `src/backend/deepscan.js` | Scheduled tasks, firewall rules, shell extensions, file types and exe-named data folders |
| `src/backend/measure.js` | Measures missing sizes and install dates from program folders |
| `src/backend/startup.js` | Startup & Services: lists entries and turns them on or off without deleting them |
| `src/backend/monitor.js` | Before/after snapshots of file system and registry, and the diff |
| `src/backend/backups.js` | Backup (`reg export`, value capture, task and firewall export, Recycle Bin), removal and restore |
| `src/backend/debloat.js` | Debloat tweak catalog: reads, applies and reverts registry values |
| `src/backend/restore.js` | Creates System Restore points with `Checkpoint-Computer` and explains why Windows skipped one |
| `src/backend/paths.js` | Well-known install roots, plus guards that refuse to touch system folders |
| `src/backend/api.js` | Answers the UI's requests by calling the modules above |
| `src/*.jsx` | React UI |
| `test/` | Safety tests (`node --test`), run against the same backend code through a Node.js version of the system layer |

## Limitations

- The installation monitor records folders up to three levels deep and files up to two levels deep under the usual install roots. For the registry, it records keys up to two levels under `SOFTWARE`, plus Uninstall, App Paths, Run and Services. A file added deep inside a folder that already existed is not captured.
- Changes made by other programs while monitoring is active are recorded too. Review the list before deleting.
- Files are restored from the Recycle Bin, not by SweepUninstall. A restored service comes back after a restart.
- Measured sizes stop after 15 seconds or 300,000 files per folder. A "+" after the size means it is at least that large.

## Disclaimer

SweepUninstall is an independent project, written from scratch using documented Windows APIs.
It is not affiliated with, and contains no code from, Total Uninstall or Geek Uninstaller.
Uninstalling software changes your system, so review what is selected before deleting.

## License

[MIT](LICENSE)
