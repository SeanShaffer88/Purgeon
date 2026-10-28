# Purgeon 1.0.6

Purgeon helps you remove Windows programs completely and clean up what they leave behind.

## What's in this release

- **A new premium look.** A near-black design with red accents and white text: a gradient band names the open view with its headline number, the program list sits in a recessed panel, view icons rest in a floating rail, and primary buttons are red. The light and high-contrast themes still work as before.
- **System Info window.** A new button on the action bar (also in the Tools menu, and `--sysinfo` on the command line) shows your Windows edition, version and uptime, processor, memory, motherboard, graphics, every drive, optical drives and audio — with temperatures where Windows reports them.
- **Upgrades close the old copy for you.** Installing or uninstalling now asks a running Purgeon to exit cleanly first (with a forced close as a fallback), and a silent install relaunches it afterwards — no more locked-file failures or manual closing.
- **Debloat grows from 26 to 93 tweaks.** A new App Privacy section carries the same per-app permission switches as Settings › Privacy (account info, location, camera, microphone, contacts, calendar, email, messages, files, passkeys, Bluetooth, eye tracking, screenshots and more), plus new privacy, suggestions, search, Explorer and settings-sync toggles. Every tweak stays reversible, restoring the previous value when switched off.

## Files

- `Purgeon-Setup-x64.exe` — installer for 64-bit Windows 10 and 11
- `Purgeon-Portable-x64.zip` — portable package with the 64-bit build; extract it and run `Purgeon-Portable-x64.exe`

## Notes

- The binaries are unsigned (there is no code-signing certificate), so Windows SmartScreen may warn on first run.
- The portable build keeps its data in the `Purgeon Data` folder next to the executable.
