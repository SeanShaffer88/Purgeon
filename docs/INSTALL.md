# Installing Purgeon

Purgeon is free. Get it from the
[Releases page](https://github.com/SeanShaffer88/Purgeon/releases) — you
only need one of these two files:

- **Purgeon-Setup-x64.exe** — the normal installer.
- **Purgeon-Portable-x64.zip** — a portable copy that runs from any
  folder, with nothing installed.

## Setup

1. Run `Purgeon-Setup-x64.exe`.
2. Windows may show a blue "Windows protected your PC" screen. Purgeon is
   not code-signed, so choose **More info**, then **Run anyway**.
3. Follow the steps. Two optional extras — watching for new installers and
   watching startup entries — are offered as separate unticked boxes;
   leave them unticked unless you want them.
4. Start Purgeon from the Start menu. There is no account, no setup form
   and nothing to configure first: the program list fills in on its own.

To remove Purgeon afterwards, use **Settings → Apps** in Windows, like
any other program.

## Portable

1. Unzip `Purgeon-Portable-x64.zip` into any folder you can write to
   (your Documents folder works well).
2. Run `Purgeon.exe`.

The portable copy keeps its settings and backups in a `data` folder
beside the program, so moving the folder moves everything. To remove it,
delete the folder.

## What Purgeon needs

- 64-bit Windows 10 or Windows 11.
- Microsoft Edge WebView2. The setup includes its bootstrapper, which
  downloads the runtime if it is missing (that step needs the internet).
  The portable copy needs WebView2 already present, which most Windows 10
  and all Windows 11 machines have.
- Administrator rights are never needed to install or start Purgeon. A
  few jobs inside the program (for example removing a machine-wide
  program) ask Windows for admin rights at the moment you run them, and
  say why first.
