# SweepUninstall

A Windows uninstaller that removes a program and then finds the files, folders, registry keys, startup entries and services it left behind.
You can also monitor an installation to record exactly what it changes, and every removal is backed up first.

It has a compact single-list window with a dark terminal theme, built with Electron and React.

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

- **`SweepUninstall-Setup-<version>.exe`** installs for all users, with Start Menu and desktop shortcuts. You can remove it later from Settings › Apps.
- **`SweepUninstall-Portable-<version>.exe`** is a single exe that runs without installing.

Both ask for administrator rights when they start, because removing programs installed for all users, creating restore points and machine-wide debloat tweaks all need them.

The exes are not code-signed yet, so Windows SmartScreen may show "Windows protected your PC". Click **More info › Run anyway** to start it.

## Run from source

Requirements: Windows 10 or 11, and [Node.js](https://nodejs.org/) 20 or later.

```bash
git clone https://github.com/SeanShaffer88/SweepUninstall.git
cd SweepUninstall
npm install
npm start
```

`npm start` builds the React UI with Vite and launches Electron. `npm run dev` relaunches without rebuilding and adds DevTools to the View menu.

When run from source, the app starts without administrator rights. Use **File › Restart as Administrator** or the link in the status bar.

### Build the installer

```bash
npm run dist
```

This writes the installer and the portable exe to `release/`. The NSIS installer builder can't handle very long folder paths, so build from a short path such as `C:\src\SweepUninstall`.

Pushing a tag like `v0.2.0` makes GitHub Actions run the tests, build both exes and publish them as a GitHub Release.

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
| `electron/programs.cjs` | Reads the Uninstall registry keys and `Get-AppxPackage` |
| `electron/leftovers.cjs` | Leftover scan of folders, shortcuts and registry, plus match scoring |
| `electron/deepscan.cjs` | Scheduled tasks, firewall rules, shell extensions, file types and exe-named data folders |
| `electron/measure.cjs` | Measures missing sizes and install dates from program folders |
| `electron/startup.cjs` | Startup & Services: lists entries and turns them on or off without deleting them |
| `electron/monitor.cjs` | Before/after snapshots of file system and registry, and the diff |
| `electron/backups.cjs` | Backup (`reg export`, value capture, Recycle Bin), removal and restore |
| `electron/debloat.cjs` | Debloat tweak catalog: reads, applies and reverts registry values |
| `electron/restore.cjs` | Creates System Restore points with `Checkpoint-Computer` and explains why Windows skipped one |
| `electron/paths.cjs` | Well-known install roots, plus guards that refuse to touch system folders |
| `src/` | React UI |
| `test/` | Safety tests (`node --test`) |

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
