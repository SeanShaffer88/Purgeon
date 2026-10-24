# SweepUninstall

A Windows uninstaller that removes a program and then finds the files, folders, registry keys, startup entries and services it left behind.
You can also monitor an installation to record exactly what it changes, and every removal is backed up first.

It has a compact single-list window with a dark terminal theme, built with Electron and React.

![SweepUninstall main window](docs/screenshots/main.png)

## Features

**Program list**
- Desktop programs from all three registry uninstall locations (64-bit, 32-bit and per-user), with icons, size and install date
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
- Results are grouped in a checklist. Low-confidence matches start unchecked and are marked **check**.
- **Force Removal** handles programs whose uninstaller is broken or missing.
- **Analyze Leftovers** shows what belongs to a program without uninstalling it.
- Running processes in the install folder are detected and can be closed before deleting.

**Installation monitor**
- **Tools › Monitor an Installation** takes a snapshot of the file system and registry, runs your installer, takes a second snapshot and records every folder, file, registry key, startup entry and service that was added.
- Monitored programs appear under **View › Monitored Programs**. Uninstalling one removes exactly what its installation created.

**Debloat Windows**
- The **Debloat Windows** button next to the view picker (or `Ctrl+5`) lists 26 safe, reversible tweaks in five groups: Privacy & telemetry, Start/search/taskbar, Ads & suggestions, Explorer & UI, and Windows Update.
- Each option is either **ENABLED** (green, the tweak is applied) or **DISABLED** (red, Windows default). Click an option to toggle it. Turning one off restores the Windows default.
- Each option says when it takes effect: **Applies immediately**, **Needs Explorer restart** or **Needs reboot**. A **Restart Explorer** button appears when an Explorer change is pending.
- Machine-wide policies are tagged **Admin** and need SweepUninstall to run as administrator.
- Only options that are safe and widely recommended are included: no service removal, no app removal, and no security features turned off.

**Backups and restore**
- Before anything is deleted, registry keys are exported to `.reg` files and registry values are recorded with their type and data. Files go to the Recycle Bin.
- **View › Backups** re-imports the registry changes of any removal.

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

| Installation monitor | Windows Store apps |
| --- | --- |
| ![Installation monitor](docs/screenshots/monitor.png) | ![Windows Store apps](docs/screenshots/store-apps.png) |

| Debloat Windows | Debloat Windows (Explorer and Windows Update) |
| --- | --- |
| ![Debloat Windows, privacy and taskbar tweaks](docs/screenshots/debloat-top.png) | ![Debloat Windows, Explorer and Windows Update tweaks](docs/screenshots/debloat-bottom.png) |

Screenshots use demo data.

## Getting started

Requirements: Windows 10 or 11, and [Node.js](https://nodejs.org/) 20 or later.

```bash
git clone https://github.com/SeanShaffer88/SweepUninstall.git
cd SweepUninstall
npm install
npm start
```

`npm start` builds the React UI with Vite and launches Electron. `npm run dev` relaunches without rebuilding and adds DevTools to the View menu.

Programs installed for all users write to `HKEY_LOCAL_MACHINE` and Program Files, so removing them needs administrator rights.
Use **File › Restart as Administrator** or the link in the status bar.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Del` | Uninstall |
| `Shift+Del` | Force removal |
| `Ctrl+L` | Analyze leftovers |
| `Alt+Enter` / `Enter` | Properties |
| `Ctrl+F` | Search |
| `Ctrl+1` to `Ctrl+4` | Desktop programs, Store apps, Monitored programs, Backups |
| `Ctrl+5` | Debloat Windows |
| `Ctrl+M` | Monitor an installation |
| `Ctrl+S` | Export to HTML |
| `F5` | Refresh |

## How it works

| File | Role |
| --- | --- |
| `electron/programs.cjs` | Reads the Uninstall registry keys and `Get-AppxPackage` |
| `electron/leftovers.cjs` | Heuristic leftover scan, matching normalized program and publisher names |
| `electron/monitor.cjs` | Before/after snapshots of file system and registry, and the diff |
| `electron/backups.cjs` | Backup (`reg export`, value capture, Recycle Bin), removal and restore |
| `electron/debloat.cjs` | Debloat tweak catalog: reads, applies and reverts registry values |
| `electron/paths.cjs` | Well-known install roots, plus guards that refuse to touch system folders |
| `src/` | React UI |

Leftover scanning never offers drive roots, the Windows folder, your profile folder or the install roots themselves.
Generic names such as `Microsoft`, `Common Files` or `Packages` are never matched.

## Limitations

- The installation monitor records folders up to three levels deep and files up to two levels deep under the usual install roots. For the registry, it records keys up to two levels under `SOFTWARE`, plus Uninstall, App Paths, Run and Services. A file added deep inside a folder that already existed is not captured.
- Changes made by other programs while monitoring is active are recorded too. Review the list before deleting.
- Files are restored from the Recycle Bin, not by SweepUninstall. Deleted services are not restored.

## Disclaimer

SweepUninstall is an independent project, written from scratch using documented Windows APIs.
It is not affiliated with, and contains no code from, Total Uninstall or Geek Uninstaller.
Uninstalling software changes your system, so review what is selected before deleting.

## License

[MIT](LICENSE)
