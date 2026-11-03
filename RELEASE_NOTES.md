# Purgeon 1.4.1

## Fixed

- **The window reopens where you left it** — Purgeon now remembers its size, position and whether it was maximized, and restores them on the next launch. A saved spot that no longer fits a connected screen is ignored and the default size is used instead.
- **The Debloat view loads again** — it failed with an "Invalid compiled Debloat resource" message and showed no tweaks. The tweak catalog is now checked the same way Windows treats registry paths (letter case does not matter), and the full tweak list loads.
- **The close button's remembered choice sticks** — the choice the close question saves ("Remember my choice") is now also read by Purgeon itself as it starts, so the first close of a launch already follows it, and saving the choice can no longer be blocked by another operation running at the same moment.
- **Disk Usage shows a folder's contents at once** — files and folders are listed immediately and each folder's size is filled in as it is measured, instead of the whole view waiting until every folder has been measured. The Cancel button still stops the measuring, keeping whatever sizes have landed.

## New

- **DNS & encrypted lookups** (in Debloat) — per network adapter, choose automatic DNS or the Cloudflare, Google or Quad9 servers, and on Windows 11 whether lookups are encrypted (DNS over HTTPS): off, encrypted when possible, or encrypted only. Changes take a restore point first when that setting is on, and the same controls are on the command line: `--dns list`, `--dns set`, `--dns reset`.
- **A Nagle's algorithm choice per adapter**, in the same section — Windows default, or off (small packets sent immediately; can shave delay in some online games, most programs see no difference). Also `--dns nagle`.
- **Storage Sense tweak** — a new Storage & cleanup group in Debloat starts with the Settings switch for Windows' automatic low-space cleanup, per user, with the previous value restored when turned off.

Windows 10/11, x64. Unsigned, as always — no code-signing certificate.
