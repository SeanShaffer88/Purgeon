# Compatibility

## Supported

- **Windows 11** (64-bit) — full support.
- **Windows 10** (64-bit, current builds) — full support.
- **Microsoft Edge WebView2** runtime — required; the installer can fetch
  it when missing.

## Not supported

- 32-bit Windows and Windows on ARM — Purgeon is 64-bit Intel/AMD only.
- Windows 7, 8 and 8.1 — not supported.
- macOS and Linux — Purgeon is a Windows program.

## What varies by machine

- Some pages read machine-wide settings from the registry and group
  policy. On a work or school PC those settings may be locked by an
  administrator; Purgeon shows them read-only and says so.
- Store apps appear only on Windows 10 and 11, where the Store exists.
- Jobs that change machine-wide programs, services or policies need
  administrator rights; per-user programs never do. Purgeon marks those
  jobs **Admin** before you run them.
- The portable copy needs a folder it can write to, so it can keep its
  backups. It will warn instead of guessing if the folder is read-only.
