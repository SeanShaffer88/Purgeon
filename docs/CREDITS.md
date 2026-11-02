# Credits

Purgeon stands on these open-source projects:

- **[Tauri 2](https://tauri.app/)** — the app shell that turns the web
  window into a small native program, plus its dialog and notification
  plugins.
- **[React](https://react.dev/)** and **[Vite](https://vite.dev/)** —
  the window's interface and its build tooling.
- **Rust crates** — `serde` and `serde_json` (data formats), `winreg`
  (registry reads), `ferrisetw` (Windows event tracing for the monitors),
  `trash` (Recycle Bin), `flate2` (compressed backups), `sha2` (file
  hashes) and `base64`.
- **Microsoft Edge WebView2** — the web runtime built into Windows that
  displays the window.
- **PowerShell** — built into Windows; Purgeon runs its guarded system
  scripts through it.
- **NSIS** — builds the Setup installer.

Thank you to everyone who maintains these projects. Purgeon's own code
is MIT-licensed; each project above keeps its own licence.
